const { URL } = require('url');
const https = require('https');

const { assertDefined, snipValue, snipCert } = require('./util/SecretsUtil');

/**
 * Provides data for OAuth authorization requests to XSUAA, made by this server using Axios.
 * While the `AuthProvider` base class provides data for client authentication, subclasses provide the request bodies.
 *
 * Terminology:
 * - credentials: secret data stored in the environment of this server
 * - query: incoming request data
 */
module.exports = class AuthProvider {

    /**
     * Validates all data referring to client authentication or used by other methods of this class.
     */
    static #validate(credentials) {
        assertDefined('credentials', credentials);
        assertDefined('credentials.clientid', credentials.clientid);
        assertDefined('credentials.xsappname', credentials.xsappname);
        assertDefined('credentials.url', credentials.url);

        if (credentials.certificate) {
            // X.509
            assertDefined('credentials.certurl', credentials.certurl);
            assertDefined('credentials.key', credentials.key);
        } else {
            assertDefined('credentials.clientsecret', credentials.clientsecret);
        }
    }

    static urlencoded(dataObj) {
        return new URLSearchParams(dataObj).toString();
    }

    /**
     * Authenticates the query by verifying query.clientsecret or query.key (mTLS).
     *
     * This method must be called in case of the Client Credentials Grant. For this grant type,
     * only `clientsecret` or `key` from the credentials of this server are sent to XSUAA, and
     * no additional secrets are part of the query.
     *
     * For other grant types, calling this method is not required, because
     * additional secrets from the query will be verified by XSUAA, such as `passcode`.
     */

    credentials;
    query;
    #authUrl;
    #clientAuth;
    #passcodeUrl;

    /**
     * Always instantiate via AuthProviderFactory to ensure validation of query.
     * Constructor validates the credentials.
     */
    constructor(credentials, query) {
        AuthProvider.#validate(credentials);
        this.credentials = credentials;
        this.query = query;
    }

    get authUrl() {
        if (!this.#authUrl) {
            const url = new URL(this.credentials.certurl ?? this.credentials.url);
            if (this.query.subdomain) {
                url.hostname = url.hostname.replace(/^[^.]+/, this.query.subdomain);
            }
            url.pathname = '/oauth/token';
            this.#authUrl = url.toString();
        }
        return this.#authUrl;
    }

    get isX509() {
        return !!this.credentials.certificate;
    }

    /**
     * Returns data suitable as `config` parameter of `axios.post()`.
     */
    get clientAuth() {
        if (!this.#clientAuth) {
            this.#clientAuth = this.isX509
                ? {
                    httpsAgent: new https.Agent({
                        cert: this.credentials.certificate,
                        key: this.credentials.key
                    })
                }
                : {
                    auth: {
                        username: this.credentials.clientid,
                        password: this.credentials.clientsecret
                    }
                };
        }
        return this.#clientAuth;
    }

    get scope() {
        return this.credentials.xsappname + '.cds.ExtensionDeveloper';
    }

    clientAuthToLog() {
        return this.isX509
            ? `X.509 (mTLS) with certificate '${snipCert(this.credentials.certificate)}'`
            : `Basic Auth with username (clientid) '${snipValue(this.clientAuth.auth.username)}'`;
    }

    postDataToLog() {
        const publicParams = ['grant_type', 'client_id', 'scope'];
        return this.postData
            .split('&')
            .map(entry => {
                    let [k, v] = entry.split('=');
                    if (publicParams.includes(k)) {
                        return entry;
                    }
                    return `${k}=${snipValue(v)}`;
                }
            )
            .join('&');
    }

    get passcodeUrl() {
        if (!this.#passcodeUrl) {
            const url = new URL(this.credentials.url);
            if (this.query.subdomain) {
                url.hostname = url.hostname.replace(/^[^.]+/, this.query.subdomain);
            }
            url.pathname = '/passcode';
            this.#passcodeUrl = url.toString();
        }
        return this.#passcodeUrl;
    }

    /* More methods in derived classes */
}
