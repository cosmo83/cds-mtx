const cds = require('@sap/cds/lib');
const { getAuthProvider } = require('./authProvider/AuthProviderFactory');

const LOG = cds.log('mtx');
const DEBUG = cds.debug('mtx');
const axiosInstance = require('axios').create();
axiosInstance.interceptors.response.use(response => response, require('../../../lib/pruneAxiosErrors'));

async function parseBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString();
                request.body = Object.fromEntries(new URLSearchParams(body).entries());
                resolve(request.body);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function token(request, response) {
    if (request.method === 'HEAD') {
        return response.status(204).send();
    }

    const { credentials } = cds.env.requires.auth;
    const query = request.method === 'POST'
        ? await parseBody(request)
        : request.query;

    let authProvider;
    try {
        authProvider = getAuthProvider(credentials, query);
    } catch (error) {
        if (error.status >= 500 || !error.status) LOG.error(error);
        return response.status(error.status ?? 500).send(error);
    }

    DEBUG?.(`Getting auth token from`, authProvider.authUrl);

    try {
        const { data } = await axiosInstance.post(
            authProvider.authUrl,
            authProvider.postData,
            {
                ...authProvider.clientAuth,
                timeout: 1e4 // ms
            }
        );
        return response.status(200).send(data);

    } catch (axError) {
        axError.message = axError.message.replace(/\binvalid_scope\b/, `invalid_scope (${authProvider.scope})`);
        if (axError.message.includes('invalid_scope')) axError.status = 403;
        const details = (axError.response?.status === 401 ? `Client authentication used: ${authProvider.clientAuthToLog()}. ` : '') +
            `POST data: '${authProvider.postDataToLog()}'. `;
        const toLog = `Authentication failed: ${axError.message} ${details}Passcode URL: ${authProvider.passcodeUrl}`;
        const toSend = {
            error: 'Authentication failed',
            error_description: axError.message,
            passcode_url: authProvider.passcodeUrl
        };
        const status = axError.status ?? 500;

        LOG.error(toLog);
        DEBUG && LOG.error(axError);
        return response.status(status).send(toSend);
    }
}

async function authMeta(request, response) {
    const { credentials } = cds.env.requires.auth;
    const authProvider = getAuthProvider(credentials, request.query, { generic: true });
    DEBUG?.(`Sending passcode URL to client:`, authProvider.passcodeUrl);
    // NOTE: Use snake_case for properties for compatibility with RFC 8414.
    return response.status(200).send({
        passcode_url: authProvider.passcodeUrl
    });
}


module.exports = {
    token,
    authMeta
}
