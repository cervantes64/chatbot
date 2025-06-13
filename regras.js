function htmlStrongToWhatsappBold(text) {
    if (!text) return text;
    return text.replace(/<strong>([\s\S]*?)<\/strong>/gi, '*$1*');
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function simularPresencaEInteracao(sock, remoteJid, responder, statusController, msgKey) {
    if (!statusController[remoteJid]) statusController[remoteJid] = {};
    if (statusController[remoteJid].timeout) {
        clearTimeout(statusController[remoteJid].timeout);
    }

    await sock.sendPresenceUpdate('available', remoteJid);

    await new Promise(resolve => setTimeout(resolve, getRandomInt(1000, 2000)));
    if (msgKey) {
        await sock.readMessages([msgKey]);
    } else {
        await sock.readMessages([remoteJid]);
    }

    await new Promise(resolve => setTimeout(resolve, getRandomInt(1000, 1000)));
    await sock.sendPresenceUpdate('composing', remoteJid);
    await new Promise(resolve => setTimeout(resolve, getRandomInt(1000, 2000)));

    await responder();

    await sock.sendPresenceUpdate('available', remoteJid);

    if (!statusController[remoteJid]) statusController[remoteJid] = {};
    statusController[remoteJid].timeout = setTimeout(async () => {
        await sock.sendPresenceUpdate('unavailable', remoteJid);
        delete statusController[remoteJid];
    }, getRandomInt(10000, 15000));
}

module.exports = {
    htmlStrongToWhatsappBold,
    simularPresencaEInteracao,
    getRandomInt
};