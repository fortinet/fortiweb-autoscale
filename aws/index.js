'use strict';

/*
FortiWeb Autoscale AWS Module (1.0.0-beta)
Author: Fortinet
*/
exports = module.exports;
const AWS = require('aws-sdk');
const AutoScaleCore = require('fortiweb-autoscale-core');

// lock the API versions
AWS.config.apiVersions = {
    autoscaling: '2011-01-01',
    ec2: '2016-11-15',
    lambda: '2015-03-31',
    dynamodb: '2012-08-10',
    apiGateway: '2015-07-09',
    s3: '2006-03-01'
};

const
    autoScaling = new AWS.AutoScaling(),
    dynamodb = new AWS.DynamoDB(),
    docClient = new AWS.DynamoDB.DocumentClient(),
    ec2 = new AWS.EC2(),
    unique_id = process.env.UNIQUE_ID.replace(/.*\//, ''),
    custom_id = process.env.CUSTOM_ID.replace(/.*\//, ''),
    SCRIPT_TIMEOUT = 120,
    // instance comes into unhealthy after (this * interval) sec,
    // if interval=10s, then 30s; if interval=10min, then 30min;
    // so do not set interval too small or too big!
    instanceHeartBeatMaxLossCount = 3,
    DB = {
        LIFECYCLETABLE: {
            AttributeDefinitions: [
                {
                    AttributeName: 'instanceId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'actionName',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'itemSource',
                    AttributeType: 'S'
                }
            ],
            KeySchema: [
                {
                    AttributeName: 'instanceId',
                    KeyType: 'HASH'
                }
            ],
            ProvisionedThroughput: {
                ReadCapacityUnits: 1,
                WriteCapacityUnits: 1
            },
            TableName: `${custom_id}-FortiWebLifecycleItem-${unique_id}`
        },
        HEARTBEAT: {
            AttributeDefinitions: [
                {
                    AttributeName: 'instanceId',
                    AttributeType: 'S'
                }
            ],
            KeySchema: [
                {
                    AttributeName: 'instanceId',
                    KeyType: 'HASH'
                }
            ],
            ProvisionedThroughput: {
                ReadCapacityUnits: 1,
                WriteCapacityUnits: 1
            },
            TableName: `${custom_id}-FortiWebHeartBeat-${unique_id}`
        },
        ELECTION: {
            AttributeDefinitions: [
                {
                    AttributeName: 'asgName',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'instanceId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'ip',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'vpcId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'subnetId',
                    AttributeType: 'S'
                },
                {
                    AttributeName: 'voteState',
                    AttributeType: 'S'
                }
            ],
            KeySchema: [
                {
                    AttributeName: 'asgName',
                    KeyType: 'HASH'
                }
            ],
            ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
            TableName: `${custom_id}-FortiWebMasterElection-${unique_id}`
        }
    },
    moduleId = AutoScaleCore.uuidGenerator(JSON.stringify(`${__filename}${Date.now()}`));

// let logger = new AutoScaleCore.DefaultLogger();
// logger.setLoggingLevel({info: false});
let logger = null;

/**
 * Implements the CloudPlatform abstraction for the AWS api.
 */
class AwsPlatform extends AutoScaleCore.CloudPlatform {
    async init() {
        try {
            await Promise.all([
                this.tableExists(DB.HEARTBEAT),
                this.tableExists(DB.ELECTION),
                this.tableExists(DB.LIFECYCLETABLE)
            ]);
            return true;
        } catch (ex) {
            logger.warn('some tables are missing, script enters instance termination process');
            return false;
        }
    }

    async tableExists(schema) {
        try {
            await dynamodb.describeTable({ TableName: schema.TableName }).promise();
            logger.info('table exists: ', schema.TableName);
            return true;
        } catch (ex) {
            throw new Error(`table (${schema.TableName}) not exists!`);
        }
    }

    async getLifecycleItemByInstanceId(instanceId) {
        logger.info(`enter getLifecycleItemByInstanceId(), instanceId: ${instanceId}`);
        const query = {
                TableName: DB.LIFECYCLETABLE.TableName,
                KeyConditionExpression: '#InstanceId = :InstanceId',
                ExpressionAttributeNames: {
                    '#InstanceId': 'instanceId'
                },
                ExpressionAttributeValues: {
                    ':InstanceId': instanceId
                }
            },
            response = await docClient.query(query).promise(),
            items = response.Items;
        // logger.info(`response: ${JSON.stringify(response)}`);
        if (!items || !Array.isArray(items) || items.length === 0) {
            logger.log('in getLifecycleItemByInstanceId(). No lifecycle item.');
            return {};
        }
        logger.info('in getLifecycleItemByInstanceId(). ' +
            `count (${items.length}),get response: ${JSON.stringify(items)}`);
        if (items.length !== 1) {
            throw Error(`number of lifecycleitem is (${items.length})` +
                    `for instance (${instanceId})`);
        }
        let item = items[0];
        return AutoScaleCore.LifecycleItem.fromDb(item);
    }

    async getInServiceLifecycleItems() {
        let response = await docClient.scan({
            TableName: DB.LIFECYCLETABLE.TableName
        }).promise();
        let items = response.Items;
        if (!(items && items.length)) {
            logger.log('there no in service item');
            return null;
        }
        let retItems = [];
        items.forEach(item => {
            let item1 = AutoScaleCore.LifecycleItem.fromDb(item);
            retItems.push(item1);
        });
        return retItems;
    }

    async updateCreateLifecycleItem(item, failWhenExists = false) {
        logger.info('enter updateCreateLifecycleItem()');
        var params = {};
        params = {
            TableName: DB.LIFECYCLETABLE.TableName,
            Item: item.toDb()
        };
        if (!failWhenExists) {
            logger.log('updateCreateLifecycleItem should create or update item');
            return await docClient.put(params).promise();
        }
        logger.log('updateCreateLifecycleItem can fail when item exists!');
        params.ConditionExpression = 'attribute_not_exists(instanceId)';
        try {
            return await docClient.put(params).promise();
        } catch (error) {
            return false;
        }
    }

    async deleteDbLifeCycleItemByInstanceId(instanceId) {
        try {
            logger.log('cleaning up lifecycle entry of instance: ' + `${instanceId}`);
            const params = {
                TableName: DB.LIFECYCLETABLE.TableName,
                Key: {
                    instanceId: instanceId
                }
            };
            return !!await docClient.delete(params).promise();
        } catch (ex) {
            console.error('Error while cleaning up :', ex);
            return false;
        }
    }

    async getHeartBeatItemByInstanceId(instanceId) {
        logger.info('enter getHeartBeatItemByInstanceId()');
        if (!instanceId) {
            logger.error('in getHeartBeatItemByInstanceId(), error: no instanceId property found' +
            ` on instance: ${JSON.stringify(instanceId)}`);
            return Promise.reject(`invalid instance: ${JSON.stringify(instanceId)}`);
        }
        var params = {
            Key: { instanceId: instanceId },
            TableName: DB.HEARTBEAT.TableName
        };
        try {
            let data = await docClient.get(params).promise();
            // logger.info('heartbeatitem response data: ' + JSON.stringify(data));
            if (data.Item) {
                return data.Item;
            } else {
                logger.info('in getHeartBeatItemByInstanceId(): no record found');
                return null;
            }
        } catch (error) {
            logger.error('in getHeartBeatItemByInstanceId(): error. ' +
            `error: ${JSON.stringify(error)}`);
            return null;
        }
    }

    async InstanceIsHealthy(instanceId) {
        logger.info('enter InstanceIsHealthy()');
        let heartBeatLossCount = 0;
        let item = await this.getHeartBeatItemByInstanceId(instanceId);
        if (item) {
            let now = Date.now();
            if (now > item.nextHeartBeatTime) {
                let diff = now - item.nextHeartBeatTime;
                let count = diff / 1000 / item.heartBeatInterval;
                heartBeatLossCount = Math.floor(count);
            }
            if (heartBeatLossCount > instanceHeartBeatMaxLossCount) {
                return false;
            }
            return true;
        }
        return false;
    }

    async deleteHeartBeatItemByInstanceId(instanceId) {
        try {
            logger.log('cleaning up heartbeat entry of instance: ' + `${instanceId}`);
            const params = {
                TableName: DB.HEARTBEAT.TableName,
                Key: {
                    instanceId: instanceId
                }
            };
            return !!await docClient.delete(params).promise();
        } catch (ex) {
            console.error('Error while cleaning up :', ex);
            return false;
        }
    }

    async responseToAWSLifecycleHook(lifecycleItem, success) {
        logger.log('calling responseToAWSLifecycleHook()');
        try {
            // await this.updateCreateLifecycleItem(lifecycleItem);
            var params = {
                AutoScalingGroupName: lifecycleItem.detail.AutoScalingGroupName,
                LifecycleActionResult: success ? 'CONTINUE' : 'ABANDON',
                LifecycleActionToken: lifecycleItem.detail.LifecycleActionToken,
                LifecycleHookName: lifecycleItem.detail.LifecycleHookName
                // InstanceId: event.instanceId
            };
            if (!process.env.DEBUG_MODE) {
                await autoScaling.completeLifecycleAction(params).promise();
            }
            logger.log(
            `[${params.LifecycleActionResult}] applied to hook[${params.LifecycleHookName}]` +
            `with token[${params.LifecycleActionToken}] in auto-scaling group` +
            `[${params.AutoScalingGroupName}]`);
            return true;
        } catch (error) {
            logger.error(`called responseToAWSLifecycleHook. error:${error.message}`);
            return false;
        }
    }

    async getElectedMaster() {
        const
            params = {
                TableName: DB.ELECTION.TableName,
                FilterExpression: '#PrimaryKeyName = :primaryKeyValue',
                ExpressionAttributeNames: {
                    '#PrimaryKeyName': 'asgName'
                },
                ExpressionAttributeValues: {
                    ':primaryKeyValue': process.env.AUTO_SCALING_GROUP_NAME
                }
            },
            response = await docClient.scan(params).promise(),
            items = response.Items;
        if (!items || items.length === 0) {
            // logger.info('No elected master was found in the db!');
            return null;
        }
        // logger.info(`Elected master found: ${JSON.stringify(items[0])}`, JSON.stringify(items));
        return items[0];
    }

    /**
     * Get information about an instance by the given parameters.
     * @param {Object} parameters parameters accepts: instanceId, privateIp, publicIp
     */
    async describeInstance(parameters) {
        logger.info('enter describeInstance()');
        let params = {Filters: []};
        if (parameters.instanceId) {
            params.Filters.push({
                Name: 'instance-id',
                Values: [parameters.instanceId]
            });
        }
        if (parameters.publicIp) {
            params.Filters.push({
                Name: 'ip-address',
                Values: [parameters.publicIp]
            });
        }
        if (parameters.privateIp) {
            params.Filters.push({
                Name: 'private-ip-address',
                Values: [parameters.privateIp]
            });
        }
        const result = await ec2.describeInstances(params).promise();
        // logger.info(`called describeInstance, result: ${JSON.stringify(result)}`);
        return result.Reservations[0] && result.Reservations[0].Instances[0];
    }

}

class AwsAutoscaleHandler extends AutoScaleCore.AutoscaleHandler {
    constructor(platform = new AwsPlatform(), baseConfig = '') {
        super(platform, baseConfig);
        this._step = '';
        this._selfInstance = null;
    }

    async init() {
        const success = await this.platform.init();
        return success;
    }

    objectIsEmpty(obj) {
        if (Object.keys(obj).length === 0) { return true }
        return false;
    }

    async instance_in_manager_group(instanceId) {
        var params = {
            AutoScalingGroupNames: [
                process.env.AUTO_SCALING_GROUP_NAME
            ]
        };
        let data = await autoScaling.describeAutoScalingGroups(params).promise();
        let all_instances = data.AutoScalingGroups[0].Instances;
        let instance_ids = [];
        all_instances.forEach(instance => {
            instance_ids.push(instance.InstanceId);
        });
        logger.log(`in manager group instances: ${JSON.stringify(instance_ids)}`);
        if (instance_ids.includes(instanceId)) {
            return true;
        }
        return false;
    }

    async handle(event, context, callback) {
        logger.log('enter handle()');
        this._step = 'initializing';
        let proxyMethod = 'httpMethod' in event && event.httpMethod, result;
        try {
            const platformInitSuccess = await this.init();
            // enter instance termination process if cannot init for any reason
            if (!platformInitSuccess) {
                result = 'fatal error, cannot initialize.';
                logger.error(result);
                callback(null, proxyResponse(500, result));
            } else if (event.source === 'aws.autoscaling') {
                this._step = 'aws.autoscaling';
                result = await this.handleAutoScalingEvent(event);
                callback(null, proxyResponse(200, result));
            } else if (proxyMethod === 'POST') {
                logger.log('process POST method');
                const instanceId = this.findCallingInstanceId(event);
                if (!instanceId) {
                    callback(null, proxyResponse(403, 'id not provided.'));
                    return;
                }
                result = await this.instance_in_manager_group(instanceId);
                if (!result) {
                    logger.log(`instance(${instanceId}) not in the manager group. abort!`);
                    callback(null, proxyResponse(403, 'Not authorized by custom server.'));
                    return;
                }
                logger.log(`instance(${instanceId}) in the manager group`);
                this._step = 'fortiweb:handleHeartBeat';
                result = await this.handleHeartBeat(event);
                callback(null, proxyResponse(200, result));
            } else {
                this._step = '__unknow_step__';

                logger.log(`${this._step} unexpected event!`, event);
                // probably a test call from the lambda console?
                // should do nothing in response
            }

        } catch (ex) {
            if (ex.message) {
                ex.message = `${this._step}: ${ex.message}`;
            }
            try {
                console.error('ERROR while step', this._step, proxyMethod, ex);
            } catch (ex2) {
                console.error('ERROR while step', this._step, proxyMethod, ex.message, ex, ex2);
            }
            if (proxyMethod) {
                callback(null,
                    proxyResponse(500, {
                        message: ex.message,
                        stack: ex.stack
                    }));
            } else {
                callback(ex);
            }
        }

        function proxyResponse(statusCode, res) {
            const response = {
                statusCode,
                headers: {},
                body: typeof res === 'string' ? res : JSON.stringify(res),
                isBase64Encoded: false
            };
            return response;
        }
    }

    async voteInstanceAsMaster(candidateInstanceId, voteState) {
        let candidateInstance = [];
        try {
            candidateInstance =
                await this.platform.describeInstance({instanceId: candidateInstanceId});
            const params = {
                TableName: DB.ELECTION.TableName,
                Item: {
                    asgName: process.env.AUTO_SCALING_GROUP_NAME,
                    ip: candidateInstance.PrivateIpAddress,
                    /* as we support elasticIP, publicIP of master always is elasticIP */
                    //pubIp: candidateInstance.PublicIpAddress,
                    pubIp: process.env.ElasticIP,
                    instanceId: candidateInstance.InstanceId,
                    vpcId: candidateInstance.VpcId,
                    subnetId: candidateInstance.SubnetId,
                    voteState: voteState
                },
                ConditionExpression: 'attribute_not_exists(asgName)'
            };
            logger.log('masterElectionVote, candidateInstanceId: ', candidateInstanceId);
            return !!await docClient.put(params).promise();
        } catch (ex) {
            console.warn('exception while voteInstanceAsMaster, ' +
                    `instanceid (${candidateInstanceId}), exception(${ex.stack})`);
            return false;
        }
    }

    /* ==== Sub-Handlers ==== */

    async handleAutoScalingEvent(event) {
        logger.log(`calling handleAutoScalingEvent: ${event['detail-type']}`);
        logger.log(`Autoscaling event: ${JSON.stringify(event)}`);
        let result;
        switch (event['detail-type']) {
            case 'EC2 Instance-launch Lifecycle Action':
                if (event.detail.LifecycleTransition === 'autoscaling:EC2_INSTANCE_LAUNCHING') {
                    result = await this.handleLaunchingInstanceHook(event);
                }
                break;
            case 'EC2 Instance-terminate Lifecycle Action':
                if (event.detail.LifecycleTransition === 'autoscaling:EC2_INSTANCE_TERMINATING') {
                    result = await this.handleTerminatingInstanceHook(event);
                }
                break;
            case 'EC2 Instance Terminate Successful':
                result = await this.clearRecordsFinally(event.detail.EC2InstanceId);
                break;
            case 'EC2 Instance Launch Successful':
                result = await this.handleLaunchSuccessful(event);
                break;
            default:
                logger.warn(`Ignore autoscaling event type: ${event['detail-type']}`);
                break;
        }
        return result;
    }
    async electNewMaster(callerInstanceId) {
        logger.info('enter electNewMaster(), caller:', callerInstanceId);
        let healthyInstances = [],
            awaitAll = [],
            bornTimesInstances = [];
        let items = await this.platform.getInServiceLifecycleItems();
        if (!items) {
            logger.error('electNewMaster() called, but no instance in service. should not happen!');
            return false;
        }
        logger.log(`inservice items count(${items.length}), members: (${JSON.stringify(items)})`);
        let filter = async item => {
            let instanceId = item.instanceId;
            let healthy = await this.platform.InstanceIsHealthy(instanceId);
            if (healthy) {
                healthyInstances.push(instanceId);
            }
        };
        items.forEach(item => {
            awaitAll.push(filter(item));
        });
        await Promise.all(awaitAll);

        logger.info(`healthyInstances count(${healthyInstances.length}), ` +
                    `members: ${JSON.stringify(healthyInstances)}`);
        if (this.objectIsEmpty(healthyInstances)) {
            // this should never happen!
            logger.error('electNewMaster() called, but no healthy' +
                    'instance found. should not happen!');
            return false;
        }

        awaitAll = [];
        let getBornTime = async instanceId => {
            let item = await this.platform.getHeartBeatItemByInstanceId(instanceId);
            bornTimesInstances.push({instanceId: instanceId, bornTime: item.bornTime});
        };
        healthyInstances.forEach(instanceId => {
            awaitAll.push(getBornTime(instanceId));
        });
        await Promise.all(awaitAll);
        logger.info(`bornTimesInstances count(${bornTimesInstances.length}),` +
                    `members: (${JSON.stringify(bornTimesInstances)})`);
        if (this.objectIsEmpty(bornTimesInstances)) {
            logger.error('electNewMaster() called, but no bornTimes found. should not happen!');
            return false;
        }

        let eaylyestTime = 0,
            masterInstanceId = null;
        bornTimesInstances.forEach(bornTimesInstance => {
            let bornTime = bornTimesInstance.bornTime;
            if (eaylyestTime === 0) {
                eaylyestTime = bornTime;
                masterInstanceId = bornTimesInstance.instanceId;
            } else if (bornTime < eaylyestTime) {
                eaylyestTime = bornTime;
                masterInstanceId = bornTimesInstance.instanceId;
            }
        });
        if (masterInstanceId === null) {
            logger.error('electNewMaster() called, but no earlyest instance found. ' +
                        'should not happen!');
            return false;
        }
        logger.info(`new selected master (instanceId: ${masterInstanceId})`);
        let voteState = 'done';
        /** we should not delete any record info, because when our
        **   function executing, other lambda event process may has
        **   write a record! if that happens, we just fail our process!
        * */
        await this.voteInstanceAsMaster(masterInstanceId, voteState);
    }

    async attachElasticIP(instanceId) {
        let elasticIP = process.env.ElasticIP;
/*
        let params = {
          PublicIps: [
            elasticIP
          ]
        };
        const result = await ec2.describeAddresses(params).promise();
        if (!(result.Addresses && result.Addresses[0].AllocationId)) {
            logger.log('can not get association of' + 
                  `elasticIP(${elasticIP}),result is: ${JSON.stringify(result)}`);
            return
        }
*/
        let asso_params = {
            AllowReassociation: true,
            //AllocationId: result.Addresses[0].AllocationId,
            PublicIp: elasticIP,
            InstanceId: instanceId
        }
        let result1 = await ec2.associateAddress(asso_params).promise();
        logger.log('association result' + `${JSON.stringify(result1)}`);
    }

    async handleHeartBeat(event) {
        logger.info('enter handleHeartBeat()');
        const callerInstanceId = this.findCallingInstanceId(event),
            heartBeatInterval = this.findHeartBeatInterval(event);

        logger.log(`in handleHeartBeat(), callerInstanceId: ${callerInstanceId}`);

        await this.updateHeartBeatItem(callerInstanceId, heartBeatInterval);

        let
            masterIsHealthy = false,
            getConfigTimeout,
            nextTime,
            masterRecord;

        nextTime = Date.now();
        getConfigTimeout = nextTime + SCRIPT_TIMEOUT * 1000; // unit ms

        let masterRecord_pre = await this.platform.getElectedMaster();
        while (!masterIsHealthy && (nextTime < getConfigTimeout)) {
            masterRecord = await this.platform.getElectedMaster();
            if (!masterRecord) {
                logger.log('no master record, elect new master');
                await this.electNewMaster(callerInstanceId);
                continue;
            }
            if (masterRecord && masterRecord.voteState !== 'done') {
                logger.log(`master(${masterRecord.instanceId}) exists,` +
                            'but state is not done, wait for it');
                await AutoScaleCore.sleep(5000);
                continue;
            }
            masterIsHealthy = await this.platform.InstanceIsHealthy(masterRecord.instanceId);
            if (masterRecord && masterRecord.voteState === 'done' && !masterIsHealthy) {
                logger.log(`master((${masterRecord.instanceId})) exists,` +
                            'but master not healthy, delete record.');
                await this.purgeMaster(process.env.AUTO_SCALING_GROUP_NAME,
                            masterRecord.instanceId);
                continue;
            }
            logger.log(`master(${masterRecord.instanceId}) exists and is healthy.` +
                        `masterRecord: ${JSON.stringify(masterRecord)}`);
            break;
        }
        if (nextTime >= getConfigTimeout) {
            logger.log('Failed to determine the master. abort');
            throw new Error(`Failed to determine the master instance within ${SCRIPT_TIMEOUT}` +
            ' seconds. This instance is unable to bootstrap. Please report this to' +
            ' administrators.');
        }
        masterRecord = await this.platform.getElectedMaster();
        let heartbeatResponse = `{
            "master-vmid": "${masterRecord.instanceId}",
            "master-ip": "${masterRecord.ip}",
            "master-public-ip": "${masterRecord.pubIp}"
        }`;
        logger.log(`caller instance(${callerInstanceId}) get response (${heartbeatResponse})`);

        if (masterRecord_pre && masterRecord_pre.instanceId == masterRecord.instanceId) {
            logger.log("master not changed.");
        } else {
            await this.attachElasticIP(masterRecord.instanceId);
        }

        return heartbeatResponse;
    }

    async handleLaunchingInstanceHook(event) {
        logger.log('calling handleLaunchingInstanceHook()');
        /* use event.detail to create item, because it contains valid token */
        const instanceId = event.detail.EC2InstanceId,
            item = new AutoScaleCore.LifecycleItem(instanceId, event.detail);
        /* we do not have initial configuration, so just succeed */
        await this.platform.responseToAWSLifecycleHook(item, true);
        logger.log(`Fortiweb (instance id: ${instanceId}) is launching, ` +
            `lifecyclehook(${event.detail.LifecycleActionToken})`);
        return true;
    }

    async handleLaunchSuccessful(event) {
        logger.log('calling handleLaunchSuccessful()');
        const instanceId = event.detail.EC2InstanceId,
            item = new AutoScaleCore.LifecycleItem(instanceId,
                        'no-usefull-detail-in-successful-event'),
            result = await this.platform.updateCreateLifecycleItem(item);
        logger.log(`Fortiweb (instance id: ${instanceId}) launch successfully, ` +
            `lifecyclehook(${event.detail.LifecycleActionToken}), 
             result: ${JSON.stringify(result)}`);
        return result;
    }

    async cleanUpElectionItemIfIsMaster(instanceId) {
        logger.log('calling cleanUpElectionItemIfIsMaster().');
        let masterRecord = await this.platform.getElectedMaster();
        if (masterRecord && masterRecord.instanceId === instanceId) {
            logger.log(`Instance id: ${instanceId} is the master,` +
                        'delete record from election table');
            return await this.purgeMaster(process.env.AUTO_SCALING_GROUP_NAME,
                    masterRecord.instanceId);
        }
        logger.log(`Instance id: ${instanceId} not the master`);
        return true;
    }

    async handleTerminatingInstanceHook(event) {
        logger.log('calling handleTerminatingInstanceHook');
        let instanceId = event.detail.EC2InstanceId;

        // clean related election table item
        let result = await this.cleanUpElectionItemIfIsMaster(instanceId);
        if (result !== true) {
            console.error('purge master record error');
            return false;
        }

        // clean related heartbeat table item
        result = await this.platform.deleteHeartBeatItemByInstanceId(instanceId);
        if (result !== true) {
            console.error('delete heartbeat record error');
        }

        // clean related lifecycle table item
        // make new item from event.detail, because here contain the neweast token
        let item = new AutoScaleCore.LifecycleItem(instanceId, event.detail);
        result = await this.platform.responseToAWSLifecycleHook(item, true);
        if (result !== true) {
            console.error('response to AWS Lifecycle error');
            return false;
        }
        await this.platform.deleteDbLifeCycleItemByInstanceId(instanceId);

        logger.log(`Fortiweb (instance id: ${instanceId}) is terminating, ` +
                    `lifecyclehook(${event.detail.LifecycleActionToken})`);
        return;
    }

    /* mainly used for instances that not appear at
    **  the 'EC2 Instance-terminate Lifecycle Action',clear DB records
    * */
    async clearRecordsFinally(instanceId) {
        await this.cleanUpElectionItemIfIsMaster(instanceId);
        await this.platform.deleteHeartBeatItemByInstanceId(instanceId);
        await this.platform.deleteDbLifeCycleItemByInstanceId(instanceId);
        logger.log(`Fortiweb (instance id: ${instanceId}) is terminated`);
        return true;
    }

    async updateHeartBeatItem(instanceId, heartBeatInterval) {
        logger.info('enter updateHeartBeatItem()');
        let parameters = {};
        parameters.instanceId = instanceId;
        let instance = await this.platform.describeInstance(parameters);
        let nextHeartBeatTime = Date.now() + heartBeatInterval * 1000;
        let bornTime = Date.now() + 0; // change it to number.

        let item = await this.platform.getHeartBeatItemByInstanceId(instanceId);
        if (item) {
            // do not change bornTime, we use it to select a new master when needed
            bornTime = item.bornTime;
            // logger.info('tyoeof(bornTme): ' + typeof(bornTime) + ', content: ' + bornTime);
        }
        var params = {
            Item: {
                instanceId: instance.InstanceId,
                ip: instance.PrivateIpAddress,
                autoScalingGroupName: process.env.AUTO_SCALING_GROUP_NAME,
                nextHeartBeatTime: nextHeartBeatTime,
                heartBeatInterval: heartBeatInterval,
                bornTime: bornTime
            },
            TableName: DB.HEARTBEAT.TableName
        };
        let flag1 = await docClient.put(params).promise();

        return flag1;
    }

    async purgeMaster(asgName, instanceId) {
        // only purge the master with a specified instanceId in case delete others election vote.
        const params = {
            TableName: DB.ELECTION.TableName,
            Key: { asgName: asgName },
            ConditionExpression: '(#asgName = :asgName) AND (#instanceId = :instanceId)',
            ExpressionAttributeNames: {
                '#asgName': 'asgName',
                '#instanceId': 'instanceId'
            },
            ExpressionAttributeValues: {
                ':asgName': process.env.AUTO_SCALING_GROUP_NAME,
                ':instanceId': instanceId
            }
        };
        let flag;
        try {
            flag = !!await docClient.delete(params).promise();
            logger.log(`in purgeMaster(), delete item(${asgName}, ` +
                        `${instanceId}) result(${JSON.stringify(flag)})`);
            return flag;
        } catch (error) {
            logger.log(`in purgeMaster(), delete master error!${error}`);
            return false;
        }
    }

    /* ==== Utilities ==== */

    findCallingInstanceId(request) {
        if (request.headers && request.headers['Fos-instance-id']) {
            logger.info('in findCallingInstanceId(), instance Id: ' +
            `(${request.headers['Fos-instance-id']}) found.`);
            return request.headers['Fos-instance-id'];
        } else if (request.body) {
            try {
                let jsonBodyObject = JSON.parse(request.body);
                logger.info('in findCallingInstanceId(), instance Id: ' +
            `(${jsonBodyObject.instance}) found.`);
                return jsonBodyObject.instance;
            } catch (ex) {
                logger.info('in findCallingInstanceId(), unexpected body content format:' +
            `(${request.body})`);
                return null;
            }
        } else {
            logger.error('in findCallingInstanceId(), instance Id not found' +
                `. original request: ${JSON.stringify(request)}`);
            return null;
        }
    }

    findHeartBeatInterval(request) {
        if (request.body && request.body !== '') {
            try {
                let jsonBodyObject = JSON.parse(request.body);
                logger.info('in findHeartBeatInterval(): interval ' +
            `(${jsonBodyObject.interval}) found.`);
                return jsonBodyObject.interval;
            } catch (ex) {
                logger.info('in findHeartBeatInterval(): unexpected body content format ' +
            `(${request.body})`);
                return null;
            }
        } else {
            logger.error('in findHeartBeatInterval(): interval not found' +
                `. original request: ${JSON.stringify(request)}`);
            return null;
        }
    }

}

exports.AutoScaleCore = AutoScaleCore; // get a reference to the core
exports.AwsPlatform = AwsPlatform;
exports.AwsAutoscaleHandler = AwsAutoscaleHandler;

/**
 * Initialize the module to be able to run via the 'handle' function.
 * Otherwise, this module only exposes some classes.
 * @returns {Object} exports
 */
exports.initModule = () => {
    AWS.config.update({
        region: process.env.AWS_REGION
    });
    /**
     * expose the module runtime id
     * @returns {String} a unique id.
     */
    exports.moduleRuntimeId = () => moduleId;
    /**
     * Handle the auto-scaling
     * @param {Object} event The event been passed to
     * @param {Object} context The Lambda function runtime context
     * @param {Function} callback a callback function been triggered by AWS Lambda mechanism
     */
    exports.handler = async (event, context, callback) => {
        logger = new AutoScaleCore.DefaultLogger(console);
        // do not use debug, console object has no debug() method
        logger.setLoggingLevel({log: true, info: false});
        const handler = new AwsAutoscaleHandler();
        await handler.handle(event, context, callback);
    };
    return exports;
};
