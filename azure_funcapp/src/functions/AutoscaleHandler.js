const { app } = require('@azure/functions');
const FwbAutoScaleAzure = require('fortiweb-autoscale-azure');
app.http('AutoscaleHandler', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}" receive method ${context.method}`);

      //  const name = request.query.get('name') || await request.text() || 'world';
		
        await FwbAutoScaleAzure.initModule(context);
        await FwbAutoScaleAzure.handle(context, request);
        return context.res;            
    //    return { body: `Hello, ${name}!` };
    }
});
