using from '../jobs-service';

@protocol: 'rest'
@(path:'/-/cds/sms-provisioning')
@requires: 'any'
service cds.xt.SmsProvisioningService @(impl:'@sap/cds-mtxs/srv/cf/sms-provisioning-service.js') {

    @open type Subscriber {}

    @open
    @cds.persistence.skip
    entity tenant {
        key subscribedTenantId : String @assert.format: '^[^\*]+$';
            subscriber: Subscriber;
            eventType: String(64); // "CREATE/UPDATE", indicates if called for new subscription (CREATE) or dependencies update (UPDATE)
    }

    //returns array of { xsappname: String };
    @open
    @cds.persistence.skip
    @readonly
    entity dependencies {
        key app_tid // tenant id
    }
}

/* Multitenancy */
extend service cds.xt.SmsProvisioningService with {
    @open type UpgradeOptions {}
    @open type UpgradeResults {}

    action upgrade(tenants: Array of String, options: UpgradeOptions) returns UpgradeResults;

    // internal API - not so nice to model the request as parameter :( -> pass only headers?
    function getAppUrl(@open subscriptionPayload: {}, @open subscriptionHeaders: {}) returns String;
}
