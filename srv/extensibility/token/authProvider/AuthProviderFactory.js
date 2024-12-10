const AuthProvider = require('./AuthProvider');
const RefreshTokenAuthProvider = require('./RefreshTokenAuthProvider');
const PasswordAuthProvider = require('./PasswordAuthProvider');
const ClientCredentialsAuthProvider = require('./ClientCredentialsAuthProvider');
const { assertDefined } = require('./util/SecretsUtil');

module.exports = class AuthProviderFactory {

  /**
   * Validates all data relevant to the determination of the grant type.
   */
  static #validate(credentials, query, { generic }) {
    assertDefined('query', query);
    if (!generic) {
      assertDefined('presence of refresh token or passcode or clientid', !!query.refresh_token || !!query.passcode || !!query.clientid);
    }
  }

  static getAuthProvider(credentials, query, { generic = false } = {}) {
    AuthProviderFactory.#validate(credentials, query, { generic });
    return generic
        ? new AuthProvider(credentials, query)
        : query.refresh_token
            ? new RefreshTokenAuthProvider(credentials, query)
            : query.passcode
                ? new PasswordAuthProvider(credentials, query)
                : new ClientCredentialsAuthProvider(credentials, query);
  }
};
