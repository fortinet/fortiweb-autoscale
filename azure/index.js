'use strict';

/*
FortiWeb Autoscale Azure Module (1.0.0-beta)
Author: Fortinet
*/

exports = module.exports;
const AutoScaleCore = require('fortiweb-autoscale-core');
const armClient = require('./AzureArmClient');
const DATABASE_NAME = 'fortiwebInstances';
const DB_COLLECTION_MONITORED = 'instances';
const DB_COLLECTION_MASTER = 'masterPool';
const DB_COLLECTION_MUTEX = 'mutex';
const ELECTION_WAITING_PERIOD = 60;// how many seconds to wait for an election before purging it?
const SCRIPT_TIMEOUT = 100;// Azure script default timeout
const MASTER_HB_LOSS_COUNT = 3;// Master HB loss count

const moduleId = AutoScaleCore.uuidGenerator(JSON.stringify(`${__filename}${Date.now()}`));
var logger = new AutoScaleCore.DefaultLogger();


class AzureLogger extends AutoScaleCore.DefaultLogger {
    constructor(loggerObject) {
        super(loggerObject);
    }
    log() {
        if (!(this.level && this.level.log === false)) {
            this.logger.apply(null, arguments);
        }
    }
}

class AzurePlatform extends AutoScaleCore.CloudPlatform {
    async init() {
        let _initDB = async function() {
            return await armClient.CosmosDB.createDB(process.env.SCALESET_DB_ACCOUNT,
                DATABASE_NAME, process.env.REST_API_MASTER_KEY)
                .then(status => {
                    if (status === true) {
                        return Promise.all([
                            // create instances
                            armClient.CosmosDB.createCollection(
                                process.env.SCALESET_DB_ACCOUNT, DATABASE_NAME,
                                DB_COLLECTION_MONITORED, process.env.REST_API_MASTER_KEY),
                            armClient.CosmosDB.createCollection(
                                process.env.SCALESET_DB_ACCOUNT, DATABASE_NAME,
                                DB_COLLECTION_MASTER, process.env.REST_API_MASTER_KEY),
                            armClient.CosmosDB.createCollection(
                                process.env.SCALESET_DB_ACCOUNT, DATABASE_NAME,
                                DB_COLLECTION_MUTEX, process.env.REST_API_MASTER_KEY)
                        ]);
                    } else {
                        logger.info('DB exists. Skip creating collections.');
                        return true;
                    }
                });
        };

        await Promise.all([
            _initDB(),
            armClient.authWithServicePrincipal(process.env.REST_APP_ID,
                process.env.REST_APP_SECRET, process.env.TENANT_ID)]).catch(error => {
            throw error;
        });
        armClient.useSubscription(process.env.SUBSCRIPTION_ID);
    }

    async getCallbackEndpointUrl(fromContext = null) {
        return await fromContext ? fromContext.originalUrl : null;
    }

    async getInstanceById(vmId) {
        let parameters = {
            resourceGroup: process.env.RESOURCE_GROUP,
            scaleSetName: process.env.SCALESET_NAME
        };
        let virtualMachines = await this.listAllInstances(parameters);
        for (let virtualMachine of virtualMachines) {
			if (virtualMachine.name === "failed") {
				logger.warn('Azure throttling issue met');
				return null;
			}
            logger.info(`vmid: ${virtualMachine.properties.vmId}`);
            if (virtualMachine.properties.vmId === vmId) {
                return virtualMachine;
            }
        }
        return null;
    }

    async protectInstanceFromScaleIn(item, protect = true) {
        return await Promise.reject(false && protect);
    }

    async listAllInstances(parameters) {
        logger.info('calling listAllInstances in');
        try {
            logger.info('calling listAllInstances');
            let virtualMachines =
            await armClient.Compute.VirtualMachineScaleSets.listVirtualMachines(
                parameters.resourceGroup, parameters.scaleSetName);
            logger.info('called listAllInstances');
            return virtualMachines;
        } catch (error) {
            logger.logger.error(`listAllInstances > error ${JSON.stringify(error)}`);
			return [];
        }
    }

	async getInstance(parameters) {
        logger.info('calling getInstance');
        let virtualMachine =
            await armClient.Compute.VirtualMachineScaleSets.getVirtualMachine(
                parameters.resourceGroup, parameters.scaleSetName,
                parameters.virtualMachineId);
        logger.info('called getInstance');
		return virtualMachine;
	}
    async describeInstance(parameters, virtualMachine) {
        logger.info('calling describeInstance');
		/*
        let virtualMachine =
            await armClient.Compute.VirtualMachineScaleSets.getVirtualMachine(
                parameters.resourceGroup, parameters.scaleSetName,
                parameters.virtualMachineId);
		*/

        let vmPubIPAddr = await armClient.Compute.VirtualMachineScaleSets.getVirtualMachinePublicIp(
                parameters.resourceGroup, parameters.scaleSetName, parameters.virtualMachineId);

        return (function(vm) {
            vm.getPrimaryPrivateIp = () => {
                /* eslint-disable max-len */
                for (let networkInterface of vm.properties.networkProfile.networkInterfaces) {
                    if (networkInterface.properties.primary) {
                        for (let ipConfiguration of networkInterface.properties.ipConfigurations) {
                            if (ipConfiguration.properties.primary) {
                                return ipConfiguration.properties.privateIPAddress;
                            }
                        }
                    }
                }
                return null;
                /* eslint-enable max-len */
            };
            vm.getPrimaryPublicIp = () => {
                return vmPubIPAddr;
            };
        	logger.info('called describeInstance');
            return vm;
        })(virtualMachine);
    }

    /**
     * get the health check info about an instance been monitored.
     * @param {Object} instance instance object which a vmId property is required.
     * @param {Number} heartBeatInterval integer value, unit is second.
     */
    //async getInstanceHealthCheck(instance, heartBeatInterval, isMaster=false) {
    async getInstanceHealthCheck(instance, heartBeatInterval) {
        let isHealthy = true;
        logger.info('calling getInstanceHealthCheck');
        if (!(instance && instance.vmId)) {
            logger.error(`getInstanceHealthCheck > error: no vmId property found on instance: ${JSON.stringify(instance)}`); // eslint-disable-line max-len
            return Promise.reject(`invalid instance: ${JSON.stringify(instance)}`);
        }
        const queryObject = {
            query: `SELECT * FROM ${DB_COLLECTION_MONITORED} c WHERE c.scaleSetName = @scaleSetName AND c.vmId = @vmId`, // eslint-disable-line max-len
            parameters: [
                {
                    name: '@scaleSetName',
                    value: `${process.env.SCALESET_NAME}`
                },
                {
                    name: '@vmId',
                    value: `${instance.vmId}`
                }
            ]
        };

        try {
            logger.info('start to call CosmosDB.query');
            let docs = await armClient.CosmosDB.query(process.env.SCALESET_DB_ACCOUNT, {
                dbName: DATABASE_NAME,
                collectionName: DB_COLLECTION_MONITORED,
                partitioned: true,
                queryObject: queryObject
            }, process.env.REST_API_MASTER_KEY);
            if (Array.isArray(docs) && docs.length > 0) {
                logger.info('called getInstanceHealthCheck');
				//FIXME:check master's provision state
				/*
				if (isMaster) {
					if (((Date.now() - docs[0].nextHeartBeatTime) / (heartBeatInterval * 1000)) >
						MASTER_HB_LOSS_COUNT) {
						let master = docs[0],
							master_vm = null,
							parameters = {
								resourceGroup: process.env.RESOURCE_GROUP,
								scaleSetName: process.env.SCALESET_NAME,
								virtualMachineId: master.instanceId
							};
						master_vm = await this.platform.getInstance(parameters);
						if (!!master_vm && master_vm.properties.provisioningState !== "Succeeded") {
							logger.error(`Provision state for master ${master.instanceId} is ${master_vm.properties.provisioningState}.`);
							isHealthy = false;
						} else {
							if (!master_vm) {
								logger.warn(`Cannot get provision state of master ${master.instanceId}`);
							}
							isHealthy = true;
						}
					}
				} else { */
					if (((Date.now() - docs[0].nextHeartBeatTime) / (heartBeatInterval * 1000)) >
						process.env.HEART_BEAT_LOSS_COUNT) {
						/* we has missed too many heartbeat packets, set the status to unhealthy */
						logger.info(`instance(${instance.vmId}) has missed more than ` +
							`${process.env.HEART_BEAT_LOSS_COUNT} heartbeats, set the status ` +
							`to unhealthy, interval:${heartBeatInterval}`);
						isHealthy = false;
					}
				//}
                return {
                    healthy: isHealthy,
                    heartBeatLossCount: docs[0].heartBeatLossCount,
                    nextHeartBeatTime: docs[0].nextHeartBeatTime
                };
            } else {
                logger.info('called getInstanceHealthCheck: no record found');
                return null;
            }
        } catch (error) {
            logger.error(error);
            logger.info('called getInstanceHealthCheck with error.');
            return null;
        }
    }
}

class AzureAutoscaleHandler extends AutoScaleCore.AutoscaleHandler {
    constructor() {
        const baseConfig = process.env.FWB_BASE_CONFIG?.replace(/\\n/g, '\n');
        super(new AzurePlatform(), baseConfig);
        this._electionLock = null;
        this._selfInstance = null;
    }

    async handle(context, req) {
        // let x = require(require.resolve(`${process.cwd()}/azure-arm-client`));
        logger.info('start to handle autoscale');
        let response;
        try {
            await this.init();
            // handle get config
            response = await this._handleGetConfig(req);
            logger.info(response);

        } catch (error) {
            if (error instanceof Error) {
                response = error.message;
            } else { response = JSON.stringify(error) }
            context.log.error(response);
        }
        context.res = {
            // status: 200, /* Defaults to 200 */
            headers: {
                'Content-Type': 'text/plain'
            },
            body: response
        };
    }

    async _handleGetConfig(_request) {
        logger.info('calling handleGetConfig');
        let parameters,
            masterInfo,
            masterIsHealthy = false,
            selfHealthCheck,
            masterHealthCheck,
            callingInstanceId = this.findCallingInstanceId(_request),
            callingScalesetInstanceId = this.findCallingScalesetInstanceId(_request),
            heartBeatInterval = this.findHeartBeatInterval(_request),
            counter = 0,
            nextTime,
            getConfigTimeout,
            virtualMachine;

        // verify the caller (diagram: trusted source?)
        if( callingInstanceId == "get_master_info") {
            masterInfo = await this.getMasterInfo();
            if (masterInfo) {
                return this.responseToHeartBeat(masterInfo.ip, masterInfo.publicIp, masterInfo.vmId);
            } else {
                throw new Error(`Get Master failed\n.`); 
            }
        }
		if (!callingScalesetInstanceId) {
			virtualMachine = await this.platform.getInstanceById(callingInstanceId);
			if (!virtualMachine) {
				// not trusted
				throw new Error(`Unauthorized calling instance (vmid: ${callingInstanceId}). Instance not found in scale set.`); // eslint-disable-line max-len
			}
			callingInstanceId = virtualMachine.instanceId;
		} else {
			callingInstanceId = callingScalesetInstanceId;
		}
        // describe self
	
        parameters = {
            resourceGroup: process.env.RESOURCE_GROUP,
            scaleSetName: process.env.SCALESET_NAME,
            virtualMachineId: callingInstanceId
        };
		virtualMachine = await this.platform.getInstance(parameters);
        if (!virtualMachine){
            // not trusted
            throw new Error(`Unauthorized calling instance (${callingInstanceId}). Instance not found in scale set.`); // eslint-disable-line max-len
        }
		if (virtualMachine.name === "failed") {
				throw new Error(`Azure throttling issue met. Cannot identify calling instance (${callingInstanceId})`);
		}
        logger.info('check if vm provision is done');
		if (virtualMachine.properties.provisioningState === "Deleting") {
			logger.info(`${callingInstanceId} ${virtualMachine.properties.vmId} is deleting. Remove it from monitored instances collection`);
            await this.removeInstance({
                vmId: virtualMachine.properties.vmId
            });
            throw new Error(`Provision state for ${callingInstanceId} is ${virtualMachine.properties.provisioningState}.`);
		}
		if (virtualMachine.properties.provisioningState !== "Succeeded") {
            throw new Error(`Provision state for ${callingInstanceId} is ${virtualMachine.properties.provisioningState}.`);
		}
        this._selfInstance = await this.platform.describeInstance(parameters, virtualMachine);
        // is myself under health check monitoring?
        // do self health check
        logger.info(`do self under health check monitoring check, interval: ${heartBeatInterval}`);
        selfHealthCheck = await this.platform.getInstanceHealthCheck({
            vmId: this._selfInstance.properties.vmId
        }, heartBeatInterval);
        // not monitored instance?

        // add or update instance to monitored instances db
        await this.addInstanceToMonitor(this._selfInstance,
            Date.now() + heartBeatInterval * 1000);

        nextTime = Date.now();
        getConfigTimeout = nextTime + SCRIPT_TIMEOUT * 1000; // unit ms

        // (diagram: master exists?)
        while (!masterIsHealthy && (nextTime < getConfigTimeout)) {
            // get the current master
            masterInfo = await this.getMasterInfo();

            // is master healthy?
            if (masterInfo) {
                // self is master?
                if (masterInfo.ip === this._selfInstance.getPrimaryPrivateIp()) {
                    masterHealthCheck = selfHealthCheck;
                } else {
                    masterHealthCheck =
                        await this.platform.getInstanceHealthCheck(masterInfo,
                            heartBeatInterval);
                }
				masterIsHealthy = !!masterHealthCheck && masterHealthCheck.healthy;
			}

            // we need a new master! let's hold a master election!
            if (!masterIsHealthy) {
                logger.info('master is not healthy.');
                // but can I run the election? (diagram: anyone's holding master election?)
                this._electionLock = await this.AcquireMutex(DB_COLLECTION_MASTER);
                if (this._electionLock) {
                    // yes, you run it!
                    logger.info(`This thread vmid ${this._selfInstance.properties.vmId} is running an election.`);
                    try {
                        // (diagram: elect new master from queue (existing instances))
                        await this.holdMasterElection(
                            this._selfInstance, heartBeatInterval);
                        logger.info('Election completed.');
                    } catch (error) {
                        logger.error(`Something went wrong in the master election: ${error}`);
                    } finally {
                        // release the lock, let someone else run the election.
                        await this.releaseMutex(DB_COLLECTION_MASTER, this._electionLock);
                        this._electionLock = null;
                    }
                    // (diagram: master exists?)
                    masterInfo = await this.getMasterInfo();
					masterIsHealthy = !!masterInfo;
                } else {
                    logger.info(`Wait for master election (counter: ${++counter}, time:${Date.now()})`); // eslint-disable-line max-len
                }
            }
            nextTime = Date.now();
            if (!masterIsHealthy) {
                await AutoScaleCore.sleep(5000); // (diagram: wait for a moment (interval))
            }
        }

        // exit with error if script can't get election done within script timeout
        if (nextTime >= getConfigTimeout) {
            // cannot bootstrap due to master election failure.
            // (diagram: remove instance)
/*            await this.removeInstance({
                vmId: this._selfInstance.properties.vmId
            });
*/
            throw new Error(`Failed to determine the master instance within ${SCRIPT_TIMEOUT}` +
            ' seconds. This instance is unable to bootstrap. Please report this to' +
            ' administrators.');
        }

        logger.info(`respond to client, master-ip: ${masterInfo.ip}, ` +
                    `master-public-ip: ${masterInfo.publicIp}, vmid: ${masterInfo.vmId}`);
        return this.responseToHeartBeat(masterInfo.ip, masterInfo.publicIp, masterInfo.vmId);
    }

    async holdMasterElection(vmself, heartBeatInterval) { // eslint-disable-line no-unused-vars
        // list all election candidates
        let parameters = {
            resourceGroup: process.env.RESOURCE_GROUP,
            scaleSetName: process.env.SCALESET_NAME
        };
        let virtualMachine, candidate, candidates = [];
        let [virtualMachines, moniteredInstances] = await Promise.all([
            this.platform.listAllInstances(parameters),
            this.listMonitoredInstances()
        ]);
		let get_vm_failed = false;
        for (virtualMachine of virtualMachines) {
			if (virtualMachine.name === "failed") {
				get_vm_failed = true;
				break;
			}
            // if candidate is monitored, and it is in the healthy state
            // put in in the candidate pool
			if (virtualMachine.properties.provisioningState !== "Succeeded") {
				logger.info(`skip vm inst: ${virtualMachine.instanceId} due to its state is ${virtualMachine.properties.provisioningState}.`);
				continue;
			}
			//logger.info(`vm inst: ${virtualMachine.instanceId}`);
            if (moniteredInstances[virtualMachine.instanceId] !== undefined) {
                let healthCheck = await this.platform.getInstanceHealthCheck(
                    moniteredInstances[virtualMachine.instanceId], heartBeatInterval
                );
                if (healthCheck.healthy) {
					logger.info(`master candidate: ${virtualMachine.instanceId}`);
                    candidates.push(virtualMachine);
                }
            }
        }
		if (!get_vm_failed) {
			for (let inst in moniteredInstances) {
				let delete_record = true;
				for (virtualMachine of virtualMachines) {
					if (virtualMachine.instanceId === moniteredInstances[inst].instanceId) {
						delete_record = false;
						break;
					}
				}
				if (delete_record) {
					await this.removeInstance({
						vmId: moniteredInstances[inst].vmId
					});
				}
			}
			let instanceId = 0,
				master = null;
			if (candidates.length > 0) {
				// choose the one with smaller instanceId
				for (candidate of candidates) {
					if (instanceId === 0 || candidate.instanceId < instanceId) {
						instanceId = candidate.instanceId;
						master = candidate;
					}
				}
			}

			if (master) {
				logger.info(`Elected Master: ${master.instanceId}`);
				//get network interfaces
				master.properties.networkProfile.networkInterfaces =
					await armClient.Compute.VirtualMachineScaleSets.getNetworkInterface(
                		process.env.RESOURCE_GROUP,
						process.env.SCALESET_NAME,
                		master.instanceId);
				parameters = {
					resourceGroup: process.env.RESOURCE_GROUP,
					scaleSetName: process.env.SCALESET_NAME,
					virtualMachineId: instanceId
				};
				virtualMachine = await this.platform.describeInstance(parameters, master);
				logger.info(`Elected virtualMachine: ${virtualMachine.instanceId}`);
				return await this.updateMaster(virtualMachine);
			} else {
				return Promise.reject('No instance available for master.');
			}
		} else {
			//deemed myself as master
        	logger.warn('Azure throttling issue met during master election');
        	logger.warn(`Deem myself ${vmself.instanceId} as newly elected Master`);
			return await this.updateMaster(vmself);
		}
    }

    async updateMaster(instance) {
        logger.info('calling updateMaster');
        let documentContent = {
            master: 'master',
            ip: instance.getPrimaryPrivateIp(),
            publicIp: instance.getPrimaryPublicIp(),
            instanceId: instance.instanceId,
            vmId: instance.properties.vmId
        };

        let documentId = `${process.env.SCALESET_NAME}-master`,
            replaced = true;
        try {
            let doc = await armClient.CosmosDB.createDocument(process.env.SCALESET_DB_ACCOUNT,
                DATABASE_NAME, DB_COLLECTION_MASTER, documentId, documentContent, replaced,
                process.env.REST_API_MASTER_KEY);
            if (doc) {
                logger.info(`called updateMaster: master(id:${documentContent.instanceId}, ip: ${documentContent.ip}) updated.`); // eslint-disable-line max-len
                return true;
            } else {
                logger.error(`called updateMaster: master(id:${documentContent.instanceId}, ip: ${documentContent.ip}) not updated.`); // eslint-disable-line max-len
                return false;
            }
        } catch (error) {
            logger.error(`updateMaster > error: ${error}`);
            return false;
        }
    }

    async addInstanceToMonitor(instance, nextHeartBeatTime) {
        logger.info('calling addInstanceToMonitor');
        let documentContent = {
            ip: instance.getPrimaryPrivateIp(),
            publicIp: instance.getPrimaryPublicIp(),
            instanceId: instance.instanceId,
            vmId: instance.properties.vmId,
            scaleSetName: process.env.SCALESET_NAME,
            nextHeartBeatTime: nextHeartBeatTime,
            heartBeatLossCount: 0
        };

        logger.info(`vmid: ${instance.properties.vmId}, ` +
                `content: ${JSON.stringify(documentContent)}`);

        let documentId = instance.properties.vmId,
            replaced = true;
        try {
            let doc = await armClient.CosmosDB.createDocument(process.env.SCALESET_DB_ACCOUNT,
                DATABASE_NAME, DB_COLLECTION_MONITORED, documentId, documentContent, replaced,
                process.env.REST_API_MASTER_KEY);
            if (doc) {
                logger.info(`called addInstanceToMonitor: ${documentId} monitored.`);
                return true;
            } else {
                logger.error(`called addInstanceToMonitor: ${documentId} not monitored.`);
                return false;
            }
        } catch (error) {
            logger.error(`addInstanceToMonitor > error: ${error}`);
            return false;
        }
    }

    async listMonitoredInstances() {
        const queryObject = {
            query: `SELECT * FROM ${DB_COLLECTION_MONITORED} c WHERE c.scaleSetName = @scaleSetName ORDER BY c.instanceId desc`, // eslint-disable-line max-len
            parameters: [
                {
                    name: '@scaleSetName',
                    value: `${process.env.SCALESET_NAME}`
                }
            ]
        };

        try {
            let instances = {},
                docs = await armClient.CosmosDB.query(
                    process.env.SCALESET_DB_ACCOUNT, {
                        dbName: DATABASE_NAME,
                        collectionName: DB_COLLECTION_MONITORED,
                        partitioned: true,
                        queryObject: queryObject
                    }, process.env.REST_API_MASTER_KEY);
            if (Array.isArray(docs)) {
                docs.forEach(doc => {
                    instances[doc.instanceId] = doc;
                });
            }
			if (instances.size === 0) {
				logger.error('Cannot get monitored instances');
			}
			/*
			for (let inst in instances) {
				logger.info(`${inst}  =  ${instances[inst].vmId}`);
			}
			*/
            logger.info('called listMonitoredInstances');
            return instances;
        } catch (error) {
            logger.error(error);
        }
        return null;
    }

    findCallingInstanceId(_request) {
        try {
            // try to get instance id from headers
            if (_request && _request.headers && _request.headers['fwb-instance-id']) {
                return _request.headers['fwb-instance-id'];
            } else {
                // try to get instance id from body
                if (_request && _request.body && _request.body.instance) {
                    return _request.body.instance;
                } else { return null }
            }
        } catch (error) {
            return error ? null : null;
        }
    }
    findCallingScalesetInstanceId(_request) {
        try {
            // try to get instance id from headers
            if (_request && _request.headers && _request.headers['fwb-scaleset-instance-id']) {
                return _request.headers['fwb-scaleset-instance-id'];
            } else {
                // try to get instance id from body
                if (_request && _request.body && _request.body.scalesetinstance) {
                    return _request.body.scalesetinstance;
                } else { return null }
            }
        } catch (error) {
            return error ? null : null;
        }
    }

    findHeartBeatInterval(_request) {
        let _interval = 120;
        try {
            if (_request && _request.body && _request.body.interval) {
                return isNaN(_request.body.interval) ? _interval : parseInt(_request.body.interval);
            } else { return _interval }
        } catch (error) { // eslint-disable-line no-unused-var
            return _interval;
        }
    }

    async getMasterInfo() {
        const queryObject = {
            query: `SELECT * FROM ${DB_COLLECTION_MASTER} c WHERE c.id = @id`,
            parameters: [
                {
                    name: '@id',
                    value: `${process.env.SCALESET_NAME}-master`
                }
            ]
        };

        try {
            let docs = await armClient.CosmosDB.query(process.env.SCALESET_DB_ACCOUNT, {
                dbName: DATABASE_NAME,
                collectionName: DB_COLLECTION_MASTER,
                partitioned: true,
                queryObject: queryObject
            }, process.env.REST_API_MASTER_KEY);
            if (docs.length > 0) {
				return docs[0];
            } else {
                return null;
            }
        } catch (error) {
            logger.error(error);
        }
        return null;
    }

    async AcquireMutex(collectionName) {
        let _electionLock = null,
            _purge = false,
            _now = Math.floor(Date.now() / 1000);
        let _getMutex = async function() {
            const queryObject = {
                query: `SELECT * FROM ${DB_COLLECTION_MUTEX} c WHERE c.collectionName = @collectionName`, // eslint-disable-line max-len
                parameters: [
                    {
                        name: '@collectionName',
                        value: `${collectionName}`
                    }
                ]
            };

            try {
                let docs = await armClient.CosmosDB.query(process.env.SCALESET_DB_ACCOUNT, {
                    dbName: DATABASE_NAME,
                    collectionName: DB_COLLECTION_MUTEX,
                    partitioned: true,
                    queryObject: queryObject
                }, process.env.REST_API_MASTER_KEY);
                _electionLock = docs[0];
            } catch (error) {
                _electionLock = null;
                logger.error(error);
            }
            return _electionLock;
        };

        let _createMutex = async function(purge) {
            logger.info('calling _createMutex');
            let documentContent = {
                servingStatus: 'activated',
                collectionName: collectionName,
                acquireLocalTime: _now
            };

            let documentId =
                AutoScaleCore.uuidGenerator(JSON.stringify(documentContent) +
                    AutoScaleCore.moduleRuntimeId()),
                replaced = false;
            try {
                if (purge && _electionLock) {
                    await armClient.CosmosDB.deleteDocument(process.env.SCALESET_DB_ACCOUNT,
                        DATABASE_NAME, DB_COLLECTION_MUTEX, _electionLock.id,
                        process.env.REST_API_MASTER_KEY);
                    logger.info(`mutex(id: ${_electionLock.id}) was purged.`);
                }
                let doc = await armClient.CosmosDB.createDocument(
                    process.env.SCALESET_DB_ACCOUNT, DATABASE_NAME,
                    DB_COLLECTION_MUTEX, documentId, documentContent, replaced,
                    process.env.REST_API_MASTER_KEY);
                if (doc) {
                    _electionLock = doc;
                    logger.info(`called _createMutex: mutex(${collectionName}) created.`);
                    return true;
                } else {
                    logger.warn(`called _createMutex: mutex(${collectionName}) not created.`);
                    return true;
                }
            } catch (error) {
                logger.error(`_createMutex > error: ${error}`);
                return false;
            }
        };

        await _getMutex();
        // mutex should last no more than a certain waiting period
        // (Azure function default timeout is 5 minutes)
        if (_electionLock && _now - _electionLock.acquireLocalTime > ELECTION_WAITING_PERIOD) {
            // purge the dead mutex
            _purge = true;
        }
        // no mutex?
        if (!_electionLock || _purge) {
            // create one
            let created = await _createMutex(_purge);
            if (!created) {
                throw new Error(`Error in acquiring mutex(${collectionName})`);
            }
            return _electionLock;
        } else {
            return null;
        }
    }

    async releaseMutex(collectionName, mutex) {
        logger.info(`calling releaseMutex: mutex(${collectionName}, ${mutex.id}).`);
        let documentId = mutex.id;
        try {
            let deleted =
                await armClient.CosmosDB.deleteDocument(
                    process.env.SCALESET_DB_ACCOUNT, DATABASE_NAME, DB_COLLECTION_MUTEX,
                    documentId, process.env.REST_API_MASTER_KEY);
            if (deleted) {
                logger.info(`called releaseMutex: mutex(${collectionName}) released.`);
                return true;
            } else {
                logger.warn(`called releaseMutex: mutex(${collectionName}) not found.`);
                return true;
            }
        } catch (error) {
            logger.info(`releaseMutex > error: ${error}`);
            return false;
        }
    }

    /**
     *
     * @param {Ojbect} instance the instance to update. minimum required
     *      properties {vmId: <string>}
     */
    async updateInstanceToMonitor(instance) { // eslint-disable-line no-unused-vars
        // TODO: will not implement instance updating in V3
        // always return true
        return await Promise.resolve(true);
    }

    /**
     * handle instance removal
     * @param {Object} instance the instance to remove. minimum required
     *      properties{vmId: <string>}
     */
    async removeInstance(instance) { // eslint-disable-line no-unused-vars
//		let item = null;
        const queryObject = {
            query: `SELECT * FROM ${DB_COLLECTION_MONITORED} c WHERE c.scaleSetName = @scaleSetName AND c.vmId = @vmId`, // eslint-disable-line max-len
            parameters: [
                {
                    name: '@scaleSetName',
                    value: `${process.env.SCALESET_NAME}`
                },
                {
                    name: '@vmId',
                    value: `${instance.vmId}`
                }
            ]
        };

        try {
			let docs = await armClient.CosmosDB.query(
				process.env.SCALESET_DB_ACCOUNT, {
					dbName: DATABASE_NAME,
					collectionName: DB_COLLECTION_MONITORED,
					partitioned: true,
					queryObject: queryObject
				}, process.env.REST_API_MASTER_KEY);
			let item = docs[0];
			if (!item) {
				logger.error(`called delete instance ${instance.vmId} failed`);
				return false;
			}

			let deleted = await armClient.CosmosDB.deleteDocument(
				process.env.SCALESET_DB_ACCOUNT,
				DATABASE_NAME,
				DB_COLLECTION_MONITORED,
				item.id,
				process.env.REST_API_MASTER_KEY);
			if (deleted) {
				logger.info(`called delete instance ${instance.vmId} succeeded`);
				return true;
			} else {
				logger.error(`called delete instance ${instance.vmId} failed`);
				return true;
			}
        } catch (error) {
            logger.error(error);
        }
        return false;
        // TODO: will not implement instance removal in V3
        // always return true
        //return await Promise.resolve(true);
    }

    responseToHeartBeat(masterIp, masterPubIp, vmId) {
        let response = {};
        if (masterIp) {
            response['master-ip'] = masterIp;
            response['master-vmid'] = vmId;
        }
        if (masterPubIp) {
            response['master-public-ip'] = masterPubIp;
        }
        return JSON.stringify(response);
    }
}

exports.AutoScaleCore = AutoScaleCore; // get a reference to the core
exports.AzurePlatform = AzurePlatform;
exports.AzureAutoscaleHandler = AzureAutoscaleHandler;

/**
 * Initialize the module to be able to run via the 'handle' function.
 * Otherwise, this module only exposes some classes.
 */
exports.initModule = async () => {
    /**
     * expose the module runtime id
     * @returns {String} a unique id.
     */
    exports.moduleRuntimeId = () => moduleId;
    /**
     * Handle the auto-scaling
     * @param {Object} context the Azure function app runtime context.
     * @param {*} req the request object to the Azure function app.
     */
    exports.handle = async (context, req) => {
        logger = new AzureLogger(context.log);
        const handler = new AzureAutoscaleHandler();
        return await handler.handle(context, req);
    };
    return await exports;
};
