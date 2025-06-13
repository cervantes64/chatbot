require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const mysql = require('mysql2/promise');
const qrcode = require('qrcode-terminal');
const regras = require('./regras.js');

const statusController = {};
const bloqueioController = {};

const MAIN_MENU = 'menu-main';
const userState = {};
const WELCOME_MSG = "Olá! Seja bem-vindo!";
const TRIGGER_WORD = '214598';
const TRANSFER_MSG = "Transferir para o especialista";

// Função utilitária para checar gatilho em qualquer mensagem enviada (inclusive pelo script)
function checaGatilhoEEncerra(sock, sender, texto) {
    if (
        texto.toLowerCase().includes(TRIGGER_WORD) ||
        texto.toLowerCase().includes(TRANSFER_MSG.toLowerCase())
    ) {
        // Envia mensagem de transferência e agenda encerramento
        regras.simularPresencaEInteracao(sock, sender, async () => {
            await sock.sendMessage(sender, { text: TRANSFER_MSG });
        }, statusController);
        setTimeout(() => {
            userState[sender] = "encerrado";
        }, 10000);
    }
}

async function connectDB() {
    return mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0
    });
}

async function registrarNovoUsuario(pool, remoteJid) {
    const [rows] = await pool.query('SELECT id, data_entrada FROM usuarios WHERE remote_jid = ?', [remoteJid]);
    if (rows.length > 0) {
        return { primeira: false, data_entrada: rows[0].data_entrada };
    }
    await pool.query('INSERT INTO usuarios (remote_jid, data_entrada) VALUES (?, NOW())', [remoteJid]);
    return { primeira: true, data_entrada: new Date() };
}

async function getMenu(pool, menuId) {
    const [menus] = await pool.query('SELECT message FROM menus WHERE menu_id = ?', [menuId]);
    if (!menus.length) return null;
    const [options] = await pool.query('SELECT * FROM menu_options WHERE menu_id = ? ORDER BY ordem ASC, id ASC', [menuId]);
    return {
        message: menus[0].message,
        options: options.map(opt => ({
            type: opt.type,
            text: opt.text,
            target: opt.target
        }))
    };
}

function getMenuMessages(menu) {
    return menu.options.filter(opt => opt.type === 'message');
}

function getMenuButtons(menu) {
    return menu.options.filter(opt => opt.type === 'button');
}

function formatMenu(menu) {
    let msg = regras.htmlStrongToWhatsappBold(menu.message) + '\n';
    let idx = 1;
    menu.options.forEach(opt => {
        if (opt.type === 'button') {
            msg += `${idx}. ${regras.htmlStrongToWhatsappBold(opt.text)}\n`;
            idx++;
        }
    });
    return msg.trim();
}

function getOptionByNumber(menu, number) {
    let idx = 1;
    for (const opt of menu.options) {
        if (opt.type === 'button') {
            if (idx === number) return opt;
            idx++;
        }
    }
    return null;
}

async function enviarMensagensTipoMessage(sock, sender, menu, statusController, msgKey) {
    const mensagens = getMenuMessages(menu);
    for (const mensagem of mensagens) {
        await regras.simularPresencaEInteracao(sock, sender, async () => {
            await sock.sendMessage(sender, { text: regras.htmlStrongToWhatsappBold(mensagem.text) });
            checaGatilhoEEncerra(sock, sender, mensagem.text);
        }, statusController, msgKey);
        await new Promise(resolve => setTimeout(resolve, regras.getRandomInt(1000, 2000)));
    }
}

function bloquearUsuarioDepoisDe(user, horas) {
    if (bloqueioController[user]) clearTimeout(bloqueioController[user]);
    bloqueioController[user] = setTimeout(() => {
        userState[user] = "encerrado";
    }, horas * 60 * 60 * 1000);
}

async function startBot() {
    const pool = await connectDB();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ auth: state });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { qr, connection, lastDisconnect } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log("Escaneie o QR acima com o WhatsApp!");
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if ([DisconnectReason.loggedOut, DisconnectReason.connectionReplaced].includes(reason)) {
                console.log('Desconectado. Remova a pasta auth_info_baileys para novo login.');
                process.exit(1);
            } else {
                console.log('Reconectando...');
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Bot conectado!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const sender = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            if (!text) continue;

            // Bloqueio por tempo ou mingau
            if (userState[sender] === "encerrado") continue;

            // Gatilho de transferência (usuário digitou)
            if (text.toLowerCase().includes(TRIGGER_WORD)) {
                checaGatilhoEEncerra(sock, sender, text);
                continue;
            }

            // Registra usuário e agenda bloqueio para 10h após entrada
            const { primeira, data_entrada } = await registrarNovoUsuario(pool, sender);
            if (primeira) {
                bloquearUsuarioDepoisDe(sender, 10);
            } else if (data_entrada) {
                const agora = new Date();
                const entrada = new Date(data_entrada);
                const diffMs = agora.getTime() - entrada.getTime();
                if (diffMs >= 10 * 60 * 60 * 1000) {
                    userState[sender] = "encerrado";
                    continue;
                } else {
                    bloquearUsuarioDepoisDe(sender, (10 * 60 * 60 * 1000 - diffMs) / 3600000);
                }
            }

            // PRIMEIRA INTERAÇÃO: saudação + messages + menu principal (apenas uma vez)
            if (primeira) {
                userState[sender] = MAIN_MENU;
                await regras.simularPresencaEInteracao(sock, sender, async () => {
                    await sock.sendMessage(sender, { text: WELCOME_MSG });
                    checaGatilhoEEncerra(sock, sender, WELCOME_MSG);
                    await new Promise(resolve => setTimeout(resolve, regras.getRandomInt(1000, 3000)));
                    const menu = await getMenu(pool, MAIN_MENU);
                    if (menu) {
                        await enviarMensagensTipoMessage(sock, sender, menu, statusController, msg.key);
                        if (menu.options.some(opt => opt.type === 'button')) {
                            await regras.simularPresencaEInteracao(sock, sender, async () => {
                                const m = formatMenu(menu);
                                await sock.sendMessage(sender, { text: m });
                                checaGatilhoEEncerra(sock, sender, m);
                            }, statusController, msg.key);
                        }
                    }
                }, statusController, msg.key);
                continue;
            }

            // MENU ATUAL do usuário (se já está navegando)
            let currentMenu = userState[sender] || MAIN_MENU;
            let menu = await getMenu(pool, currentMenu);

            if (!menu) {
                userState[sender] = MAIN_MENU;
                menu = await getMenu(pool, MAIN_MENU);
                if (menu) {
                    await enviarMensagensTipoMessage(sock, sender, menu, statusController, msg.key);
                    if (menu.options.some(opt => opt.type === 'button')) {
                        await regras.simularPresencaEInteracao(sock, sender, async () => {
                            const m = formatMenu(menu);
                            await sock.sendMessage(sender, { text: m });
                            checaGatilhoEEncerra(sock, sender, m);
                        }, statusController, msg.key);
                    }
                }
                continue;
            }

            // Se texto for "menu", volta para o menu principal
            if (/^menu$/i.test(text.trim())) {
                userState[sender] = MAIN_MENU;
                const menu = await getMenu(pool, MAIN_MENU);
                if (menu) {
                    await enviarMensagensTipoMessage(sock, sender, menu, statusController, msg.key);
                    if (menu.options.some(opt => opt.type === 'button')) {
                        await regras.simularPresencaEInteracao(sock, sender, async () => {
                            const m = formatMenu(menu);
                            await sock.sendMessage(sender, { text: m });
                            checaGatilhoEEncerra(sock, sender, m);
                        }, statusController, msg.key);
                    }
                }
                continue;
            }

            // Se for número, processa opção de botão
            const num = parseInt(text, 10);
            const chosenOpt = (!isNaN(num)) ? getOptionByNumber(menu, num) : null;

            if (chosenOpt) {
                if (chosenOpt.target) {
                    const nextMenu = await getMenu(pool, chosenOpt.target);
                    if (nextMenu) {
                        userState[sender] = chosenOpt.target;
                        await enviarMensagensTipoMessage(sock, sender, nextMenu, statusController, msg.key);
                        if (nextMenu.options.some(opt => opt.type === 'button')) {
                            await regras.simularPresencaEInteracao(sock, sender, async () => {
                                const m = formatMenu(nextMenu);
                                await sock.sendMessage(sender, { text: m });
                                checaGatilhoEEncerra(sock, sender, m);
                            }, statusController, msg.key);
                        }
                    } else {
                        await regras.simularPresencaEInteracao(sock, sender, async () => {
                            await sock.sendMessage(sender, { text: 'Opção inválida ou menu não encontrado.' });
                        }, statusController, msg.key);
                    }
                } else if (chosenOpt.type === 'message') {
                    await regras.simularPresencaEInteracao(sock, sender, async () => {
                        await sock.sendMessage(sender, { text: regras.htmlStrongToWhatsappBold(chosenOpt.text) });
                        checaGatilhoEEncerra(sock, sender, chosenOpt.text);
                    }, statusController, msg.key);
                }
                continue;
            }

            // Se não reconhecido, envia todas as mensagens tipo message do menu
            const msgOpts = getMenuMessages(menu);
            if (msgOpts.length) {
                await enviarMensagensTipoMessage(sock, sender, menu, statusController, msg.key);
            } else {
                await regras.simularPresencaEInteracao(sock, sender, async () => {
                    await sock.sendMessage(sender, { text: 'Por favor, responda apenas com o número da opção desejada ou envie "menu".' });
                }, statusController, msg.key);
            }
        }
    });
}

startBot();