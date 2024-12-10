const AuthProvider = require('./AuthProvider');
const { assertDefined } = require('./util/SecretsUtil');

/**
 * Provides credentials according to RFC 6749, 4.4. Client Credentials Grant.
 * See also https://docs.cloudfoundry.org/api/uaa/index.html#client-credentials-grant
 */

module.exports = class ClientCredentialsAuthProvider extends AuthProvider {

    static #GRANT_TYPE = 'client_credentials';

    constructor(credentials, query) {
        super(credentials, query);
        assertDefined('query.clientid', query.clientid);
    }

    /**
     * Returns data suitable as POST request body.
     */
    get postData() {
        return AuthProvider.urlencoded({
            grant_type: ClientCredentialsAuthProvider.#GRANT_TYPE,
            client_id: this.credentials.clientid,
            scope: this.scope
        });
    }
}
