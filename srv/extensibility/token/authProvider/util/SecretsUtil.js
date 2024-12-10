module.exports = class SecretsUtil {

    static assertDefined(name, actual) {
        if (!actual) {
            const error = new Error(`invalid ${name}: '${actual}'`);
            error.status = 400
            throw error;
        }
    }

    static prune(value) {
        return typeof value === 'string' ? value.replace(/\n|-----(BEGIN|END)[\w ]+-----/g, '').trim() : value;
    }

    static snipValue(secretValue) {
        const exposeLen = 2;
        if (!secretValue) {
            return secretValue;
        }
        secretValue = SecretsUtil.prune(secretValue);
        return secretValue.slice(0, exposeLen) + '…';
    }

    static snipCert(secretCert) {
        const exposeLen = 4;
        if (!secretCert) {
            return secretCert;
        }
        secretCert = SecretsUtil.prune(secretCert);
        return secretCert.slice(0, exposeLen) + '…';
    }
};
