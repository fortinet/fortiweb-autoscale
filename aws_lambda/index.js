'use strict';

/*
FortiWeb Autoscale AWS Lambda Function (1.0.0-beta)
Author: Fortinet
*/

const fwbAutoscaleAws = require('fortiweb-autoscale-aws');
/**
 * AWS Lambda Entry.
 * @param {Object} event The event been passed to
 * @param {Object} context The Lambda function runtime context
 * @param {Function} callback a callback function been triggered by AWS Lambda mechanism
 */
exports.AutoscaleHandler = async (event, context, callback) => {
    console.log('Incoming event dump begin');
    console.log(JSON.stringify(event));
    console.log('Incoming event dump end');
    fwbAutoscaleAws.initModule();
    await fwbAutoscaleAws.handler(event, context, callback);
};
