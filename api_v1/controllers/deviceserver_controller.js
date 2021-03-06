/**
 * Device server (DS) controller
 * This methods consumes DS REST API and navigate through its resources.
 *
 */


/**
 * Login credentials - API Keys from the developer console
 * In production environment uses heroku config variables
 *
 */

var config = require('./../../config.js');
const Utils = require('../helpers/Utils');

var LOGIN_ACCESS_KEY,
    LOGIN_ACCESS_SECRET;

if (process.env.NODE_ENV === 'production') {
    if (LOGIN_ACCESS_KEY === undefined || LOGIN_ACCESS_SECRET === undefined){
        LOGIN_ACCESS_KEY = config.LOGIN_ACCESS_KEY;
        LOGIN_ACCESS_SECRET = config.LOGIN_ACCESS_SECRET;  
    } else {
    LOGIN_ACCESS_KEY = process.env.LOGIN_ACCESS_KEY;
    LOGIN_ACCESS_SECRET = process.env.LOGIN_ACCESS_SECRET;
    }
} else {
    LOGIN_ACCESS_KEY = config.LOGIN_ACCESS_KEY;
    LOGIN_ACCESS_SECRET = config.LOGIN_ACCESS_SECRET;
}

var creator = require('creator-js-client')(LOGIN_ACCESS_KEY, LOGIN_ACCESS_SECRET);
var db_controller = require('../controllers/db_controller');

//------------------------------------------------------------------------------
/**
 * Subscribe to 'clientConnected' event.
 *
 */
exports.subscribeToClientConnect = function (url, callback) {
    const promise = creator.request(
        {
            steps: ['subscriptions'],
            method: 'POST',
            data: {
                'SubscriptionType': 'ClientConnected',
                'Url': url
            }
        });
    return promise.nodeify(callback);
};

/**
 * Subscribe to 'clientUpdated' event.
 *
 */
exports.subscribeToClientUpdate = function (url, callback) {
    const promise = creator.request(
        {
            steps: ['subscriptions'],
            method: 'POST',
            data: {
                'SubscriptionType': 'ClientUpdated',
                'Url': url
            }
        });
    return promise.nodeify(callback);
};

/**
 * Subscribe to observation of specific objectId instance.
 *
 */
function subscribeToObservation(clientName, objectId, instanceId, property, url) {
    const promise = creator.request(
        {
            steps: ['clients', {Name: clientName},
                'objecttypes', {ObjectTypeID: objectId.toString()},
                'instances', {InstanceID: instanceId.toString()},
                'subscriptions'],
            method: 'POST',
            data: {
                'SubscriptionType': 'Observation',
                'Url': url,
                'Property': property
            },
            nocache: true
        });
    return promise;
}

/**
 * Checks whether client has specified property on specified object instance.
 * Promise will return false result even when connection to device server fails or
 * client/object does not exist on device server.
 * @param clientName on which check is performed
 * @param objectID
 * @param instanceID
 * @param property
 * @returns {Promise|Promise.<bool>|*}
 * 
 */
function checkForResourceExistence(clientName, objectID, instanceID, property) {
    const promise = creator.request(
        {
            steps: ['clients', {Name: clientName},
                'objecttypes', {ObjectTypeID: objectID.toString()},
                'instances', {InstanceID: instanceID.toString()}],
            method: 'GET',
            nocache : true
        })
        .then((response) => {
            if (response.statusCode >= 400 || response.body[property] === undefined) {
                return false;
            }
            return true;
        }, () => {
            return false;
        });
    return promise;
}

/**
 * Synchronize temperature, i.e.
 *  - request first instance of temperature object
 *  - then update client with that data
 * 
 */
function syncTemperature(item) {
    var cl = item;
    console.log("Requesting temperatures for client: %s", cl.Name);
    const promise = creator.request(
        {
            steps: ['clients', {Name: item.Name},
                'objecttypes', {ObjectTypeID: '3303'},
                'instances', {InstanceID: '0'}],
            method: 'GET'
        })
        .then((response) => {
            console.log("Updating client [%s] with recent temperatures: code[%s]", cl.Name, response.statusCode);
            if (response.statusCode == 200) {
                db_controller.updateClient(cl, response.body);
            }
            return response;
        });
    return promise;
}


/**
 * This method is responsible for initializng app.
 * It requests all clients from DS and:
 *  - insert or update client in db
 *  - tries to subscribe for temp change events
 *  - updates client with most recent data
 * 
 */
exports.initialize = function (handler) {
    console.log("Initializing Device Server controller");
    const promise = creator.request({steps: ['clients']})
        .then((response) => {
            if (response.statusCode >= '400') {
                return Promise.reject(new Error("Requesting clients failed with code: %d", response.statusCode));
            }
            return response.body.Items;
        })
        .then((items) => {
            return db_controller.tryInsertClients(items, handler);
        })
        .then((clients) => {

            return Promise.all(clients.map(cl => {
                return subscribeToObservation(cl.Name, '3303', '0', 'SensorValue', Utils.getHost(config.HOST) + '/api/v1/notifications/temperatureChanged')
                    .then((response) => {
                        console.log(response);
                        return cl;
                    })
                    .then((cl) => {
                        return syncTemperature(cl)
                            .then((response) => {
                                console.log("Sync temperatures: %s", response.statusCode);
                            });
                    });

            }));
        })
        .catch((error) => {
            console.error(error);
        });
    return promise.nodeify(handler);
};

exports.onClientConnected = function (req, res, handler) {
    res.sendStatus(204);
    console.log("Client connected: %s", req.body);
};

/**
 * Callback triggered when new client is connected.
 * What it does:
 * - extracts client id from subscription link
 * - request clients to match that id
 * - tryies to insert new client to db
 * - subscribe to temperature change
 * 
 */
exports.onClientUpdated = function (req, res, handler) {
    res.sendStatus(204);

    if (req.body.Items.length === 0) {
        return;
    }
    var items = req.body.Items[0];
    var subscription = items.Links.filter(function (element) {
        return element.rel === "client";
    });
    if (subscription.length === 0) {
        console.error("[onClientUpdated] Could not find client url!");
        return;
    }

    return creator.request({steps: ['clients']})
        .then((response) => { //request clients and find one matching subscription id
            var clients = response.body.Items;
            var filteredClients = clients.filter(function (c) {
                var href = subscription[0].href;
                var links = c.Links.filter(function (l) {
                    return l.href.indexOf(href) !== -1;
                });
                return links.length > 0;
            });

            return filteredClients[0];
        })
        .then((c) => {
            return checkForResourceExistence(c.Name, 3303, 0, 'SensorValue')
                .then((exist) => {
                    if (exist === true)
                        return c;
                    return Promise.reject("Client [" +c.Name + "] does not have [SensorValue] property on object 3303/0");
                });
        })
        .then((c) => {	//try add client to db
            return db_controller.tryInsertClient(c);
        })
        .then((c) => {
            console.log("Subscribing client %s to temp changes", c.Name);
            return subscribeToObservation(c.Name, '3303', '0', 'SensorValue', Utils.getHost(config.HOST) + '/api/v1/notifications/temperatureChanged')
                .then((response) => {
                    console.log(response);
                    return c;
                })
                .then((c) => {
                    return syncTemperature(c)
                        .then((response) => {
                            console.log("Sync temperatures: %s", response.statusCode);
                        })
                        .catch((error) => {
                            console.error(error);
                        });
                });
        })
        .catch(error => {
            console.error(error);
        });
};