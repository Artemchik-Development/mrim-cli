#!/usr/bin/env node

const net = require('net');
const readline = require('readline');
const iconv = require('iconv-lite');

const MAGIC = 0xDEADBEEF;
const PROTOCOL_VERSION = 0x0A01000D;

const CMD = {
    MRIM_CS_HELLO: 0x1001,
    MRIM_CS_HELLO_ACK: 0x1002,
    MRIM_CS_LOGIN_ACK: 0x1004,
    MRIM_CS_LOGIN_REJ: 0x1005,
    MRIM_CS_PING: 0x1006,
    MRIM_CS_MESSAGE: 0x1008,
    MRIM_CS_MESSAGE_ACK: 0x1009,
    MRIM_CS_MESSAGE_RECV: 0x1011,
    MRIM_CS_MESSAGE_STATUS: 0x1012,
    MRIM_CS_LOGOUT: 0x1013,
    MRIM_CS_USER_INFO: 0x1015,
    MRIM_CS_ADD_CONTACT: 0x1019,
    MRIM_CS_ADD_CONTACT_ACK: 0x101A,
    MRIM_CS_CHANGE_STATUS: 0x1022,
    MRIM_CS_CONTACT_LIST2: 0x1037,
    MRIM_CS_LOGIN2: 0x1038,
    MRIM_CS_USER_STATUS: 0x100f
};

class PacketWriter {
    constructor(command, seq) {
        this.command = command;
        this.seq = seq;
        this.data = Buffer.alloc(0);
    }

    writeUL(val) {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(val, 0);
        this.data = Buffer.concat([this.data, buf]);
    }

    writeLPS(str) {
        if (str === null || str === undefined || str === '') {
            this.writeUL(0);
            return;
        }
        const strBuf = iconv.encode(str, 'win1251');
        this.writeUL(strBuf.length);
        this.data = Buffer.concat([this.data, strBuf]);
    }

    build() {
        const header = Buffer.alloc(44);
        header.writeUInt32LE(MAGIC, 0);
        header.writeUInt32LE(PROTOCOL_VERSION, 4);
        header.writeUInt32LE(this.seq, 8);
        header.writeUInt32LE(this.command, 12);
        header.writeUInt32LE(this.data.length, 16);
        header.writeUInt32LE(0, 20);
        header.writeUInt32LE(0, 24);
        header.fill(0, 28, 44);
        return Buffer.concat([header, this.data]);
    }
}

class PacketReader {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    readUL() {
        if (this.offset + 4 > this.buffer.length) return 0;
        const val = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return val;
    }

    readLPS() {
        const len = this.readUL();
        if (len === 0 || this.offset + len > this.buffer.length) {
            if (len > 0 && this.offset < this.buffer.length) {
                const strBuf = this.buffer.slice(this.offset);
                this.offset = this.buffer.length;
                return iconv.decode(strBuf, 'win1251');
            }
            return '';
        }
        const strBuf = this.buffer.slice(this.offset, this.offset + len);
        this.offset += len;
        return iconv.decode(strBuf, 'win1251');
    }
    
    hasMore() {
        return this.offset < this.buffer.length;
    }
}

let seqNum = 1;
let mrimClient = null;
let pingInterval = null;

let groups =[];
let contacts =[];

let activeChatEmail = null;
let activeChatName = null;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'mrim> '
});

function getStatusStr(status) {
    if (status === 0x0) return 'Оффлайн';
    if (status === 0x1) return 'Онлайн';
    if (status === 0x2) return 'Отошёл';
    if (status === 0x4) return 'Не беспокоить';
    if (status === 0x80000001) return 'Невидимка';
    return `Статус: 0x${status.toString(16)}`;
}

function printContactList() {
    console.log('\n========= КОНТАКТ-ЛИСТ =========');
    console.log('Для начала чата просто введите номер контакта.\n');
    
    groups.forEach((g, index) => {
        const groupContacts = contacts.filter(c => c.groupId === index);
        if (groupContacts.length > 0 || g.name !== 'Неизвестная группа') {
            console.log(`[Группа] ${g.name}`);
        }
        
        if (groupContacts.length === 0) {
            console.log('   (пусто)');
        } else {
            groupContacts.forEach(c => {
                const statusStr = getStatusStr(c.status);
                console.log(`[${c.displayId}] ${c.nickname} (${c.email}) - ${statusStr}`);
            });
        }
        console.log('');
    });
    
    const validGroupIds = new Set(groups.map((_, i) => i));
    const detached = contacts.filter(c => !validGroupIds.has(c.groupId));
    if (detached.length > 0) {
        console.log('[Без группы]');
        detached.forEach(c => {
            console.log(`[${c.displayId}] ${c.nickname} (${c.email}) - ${getStatusStr(c.status)}`);
        });
    }
    console.log('================================\n');
}

function sendMessage(to, text) {
    const packet = new PacketWriter(CMD.MRIM_CS_MESSAGE, seqNum++);
    packet.writeUL(0);
    packet.writeLPS(to);
    packet.writeLPS(text);
    packet.writeLPS('');
    mrimClient.write(packet.build());
}

function connectToRedirector(host, port) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ host, port }, () => {
            console.log(`[INFO] Подключение к перенаправляющему серверу ${host}:${port}...`);
        });
        let data = '';
        client.on('data', chunk => { data += chunk.toString(); });
        client.on('end', () => resolve(data.trim()));
        client.on('error', err => reject(err));
    });
}

function connectToMainServer(mainHost, mainPort) {
    mrimClient = net.createConnection({ host: mainHost, port: mainPort }, () => {
        console.log(`[INFO] Подключено к основному серверу ${mainHost}:${mainPort}`);
        const helloPacket = new PacketWriter(CMD.MRIM_CS_HELLO, seqNum++);
        mrimClient.write(helloPacket.build());
    });

    let buffer = Buffer.alloc(0);

    mrimClient.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        
        while (buffer.length >= 44) {
            const magic = buffer.readUInt32LE(0);
            if (magic !== MAGIC) {
                console.error('[ERROR] Рассинхронизация протокола!');
                mrimClient.destroy();
                return;
            }

            const dataLen = buffer.readUInt32LE(16);
            if (buffer.length >= 44 + dataLen) {
                const packetData = buffer.slice(44, 44 + dataLen);
                const cmd = buffer.readUInt32LE(12);
                const seq = buffer.readUInt32LE(8);
                buffer = buffer.slice(44 + dataLen);
                
                try {
                    handlePacket(cmd, seq, packetData);
                } catch(e) {
                    console.error(`[ERROR] Ошибка при обработке пакета:`, e.message);
                }
            } else {
                break;
            }
        }
    });

    mrimClient.on('close', () => {
        console.log('\n[INFO] Соединение разорвано.');
        if (pingInterval) clearInterval(pingInterval);
        process.exit(0);
    });
}

function handlePacket(cmd, seq, dataBuf) {
    const reader = new PacketReader(dataBuf);
    
    switch(cmd) {
        case CMD.MRIM_CS_HELLO_ACK:
            const pingTime = reader.readUL();
            console.log(`[SERVER] HELLO_ACK. Интервал пинга: ${pingTime}с`);
            if (pingTime > 0) {
                pingInterval = setInterval(() => {
                    const pingPacket = new PacketWriter(CMD.MRIM_CS_PING, seqNum++);
                    mrimClient.write(pingPacket.build());
                }, pingTime * 1000);
            }
            console.log('Введите "/login <логин> <пароль>" для авторизации.');
            rl.prompt();
            break;

        case CMD.MRIM_CS_LOGIN_ACK:
            console.log('\n[SERVER] Авторизация успешна!');
            rl.prompt();
            break;

        case CMD.MRIM_CS_LOGIN_REJ:
            const reason = reader.readLPS();
            console.log(`\n[SERVER] В авторизации отказано: ${reason}`);
            rl.prompt();
            break;

        case CMD.MRIM_CS_CONTACT_LIST2:
            reader.readUL();
            const groupsCount = reader.readUL();
            const groupsMask = reader.readLPS();
            const contactsMask = reader.readLPS();

            groups =[];
            for (let i = 0; i < groupsCount; i++) {
                let group = { flags: 0, name: 'Неизвестная группа' };
                for (let ch of groupsMask) {
                    if (ch === 'u') group.flags = reader.readUL();
                    else if (ch === 's') group.name = reader.readLPS();
                }
                groups.push(group);
            }

            contacts =[];
            let currentId = 1;
            
            while (reader.hasMore()) {
                let props =[];
                for (let ch of contactsMask) {
                    if (ch === 'u') props.push(reader.readUL());
                    else if (ch === 's') props.push(reader.readLPS());
                }
                
                if (props.length >= 6) {
                    contacts.push({
                        displayId: currentId++,
                        flags: props[0],
                        groupId: props[1],
                        email: props[2],
                        nickname: props[3] || props[2],
                        auth: props[4],
                        status: props[5]
                    });
                }
            }

            printContactList();
            rl.prompt();
            break;

        case CMD.MRIM_CS_MESSAGE_ACK:
            const msgId = reader.readUL();
            const flags = reader.readUL();
            const from = reader.readLPS();
            const plainText = reader.readLPS();
            const rtfText = reader.readLPS();
            
            if (activeChatEmail === from) {
                console.log(`\n[${from}]: ${plainText}`);
            } else {
                const senderName = contacts.find(c => c.email === from)?.nickname || from;
                console.log(`\n[СООБЩЕНИЕ от ${senderName}] ${plainText}`);
            }
            
            const recvPacket = new PacketWriter(CMD.MRIM_CS_MESSAGE_RECV, seqNum++);
            recvPacket.writeUL(msgId);
            recvPacket.writeLPS(from);
            mrimClient.write(recvPacket.build());
            
            rl.prompt();
            break;

        case CMD.MRIM_CS_USER_STATUS:
            const userStatus = reader.readUL();
            let statusEmail = reader.readLPS();
            if (reader.hasMore()) {
                reader.readLPS(); reader.readLPS();
                statusEmail = reader.readLPS();
            }
            
            const contact = contacts.find(c => c.email === statusEmail);
            if (contact) {
                contact.status = userStatus;
                if (activeChatEmail !== statusEmail) {
                    console.log(`\n[СТАТУС] ${contact.nickname} теперь ${getStatusStr(userStatus)}`);
                }
            }
            rl.prompt();
            break;

        default:
            break;
    }
}

rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
        rl.prompt();
        return;
    }

    if (activeChatEmail) {
        if (input === '/back') {
            activeChatEmail = null;
            activeChatName = null;
            console.log('\nВы вышли из режима чата.');
            rl.setPrompt('mrim> ');
            rl.prompt();
            return;
        }

        sendMessage(activeChatEmail, input);
        rl.prompt();
        return;
    }

    const args = input.split(' ');
    const command = args[0];

    if (!mrimClient && command !== '/exit') {
        console.log('Ещё нет подключения к серверу.');
        rl.prompt();
        return;
    }

    if (/^\d+$/.test(command)) {
        const id = parseInt(command, 10);
        const contact = contacts.find(c => c.displayId === id);
        
        if (contact) {
            activeChatEmail = contact.email;
            activeChatName = contact.nickname;
            console.log(`\n================================`);
            console.log(`Открыт чат с: ${activeChatName} (${activeChatEmail})`);
            console.log(`Введите текст и нажмите Enter для отправки.`);
            console.log(`Для выхода обратно в меню введите /back`);
            console.log(`================================\n`);
            
            rl.setPrompt(`${activeChatName}> `);
            rl.prompt();
        } else {
            console.log('Контакт с таким номером не найден. Введите /cl для списка.');
            rl.prompt();
        }
        return;
    }

    switch(command) {
        case '/login':
            const email = args[1];
            const password = args.slice(2).join(' ');
            if (!email || !password) {
                console.log('Использование: /login <почта> <пароль>');
            } else {
                const packet = new PacketWriter(CMD.MRIM_CS_LOGIN2, seqNum++);
                packet.writeLPS(email);
                packet.writeLPS(password);
                packet.writeUL(0x01);
                packet.writeLPS('STATUS_ONLINE');
                packet.writeLPS('Онлайн');
                packet.writeLPS('');
                packet.writeUL(0x000003FF);
                packet.writeLPS('client="magent" version="5.0" build="2094"');
                packet.writeLPS('MRA 5.0 (build 2094);');
                mrimClient.write(packet.build());
            }
            break;

        case '/msg':
            const to = args[1];
            const text = args.slice(2).join(' ');
            if (!to || !text) {
                console.log('Использование: /msg <получатель> <текст>');
            } else {
                sendMessage(to, text);
            }
            break;

        case '/contacts':
        case '/cl':
            if (groups.length === 0 && contacts.length === 0) {
                console.log('Контакт-лист пуст или ещё не загружен.');
            } else {
                printContactList();
            }
            break;

        case '/status':
            const statusVal = parseInt(args[1], 16) || 0x01;
            const packet = new PacketWriter(CMD.MRIM_CS_CHANGE_STATUS, seqNum++);
            packet.writeUL(statusVal);
            packet.writeLPS('STATUS_ONLINE');
            packet.writeLPS('Онлайн');
            packet.writeLPS('');
            packet.writeUL(0x000003FF);
            mrimClient.write(packet.build());
            console.log(`Статус сменен на 0x${statusVal.toString(16)}`);
            break;

        case '/add':
            const contactEmail = args[1];
            const nickname = args.slice(2).join(' ') || contactEmail;
            if (!contactEmail) {
                console.log('Использование: /add <почта>[никнейм]');
            } else {
                const addPacket = new PacketWriter(CMD.MRIM_CS_ADD_CONTACT, seqNum++);
                addPacket.writeUL(0);
                addPacket.writeUL(0);
                addPacket.writeLPS(contactEmail);
                addPacket.writeLPS(nickname);
                addPacket.writeLPS('');
                
                const authReq = new PacketWriter(0, 0); 
                authReq.writeUL(2);
                authReq.writeLPS(contactEmail);
                authReq.writeLPS('Здравствуйте. Пожалуйста, добавьте меня в список ваших контактов.');
                addPacket.writeLPS(authReq.data.toString('base64'));
                mrimClient.write(addPacket.build());
                console.log(`Запрос на добавление отправлен ${contactEmail}`);
            }
            break;

        case '/help':
            console.log('Доступные команды:');
            console.log('  /login <почта> <пароль> - Авторизация');
            console.log('  /contacts (/cl)         - Показать контакт-лист');
            console.log('  <номер>                 - Начать чат с контактом из списка');
            console.log('  /msg <почта> <текст>    - Быстрая отправка сообщения (без чата)');
            console.log('  /status <hex_code>      - Смена статуса (Например: /status 1)');
            console.log('  /add <почта> [ник]      - Добавление контакта');
            console.log('  /exit                   - Выход');
            break;

        case '/exit':
            console.log('Завершение работы...');
            if (mrimClient) mrimClient.destroy();
            process.exit(0);
            break;

        default:
            console.log('Неизвестная команда или неверный номер контакта. Введите /help для справки.');
            break;
    }
    rl.prompt();
});

async function start() {
    const host = process.argv[2] || 'mrim.mail.ru';
    const port = parseInt(process.argv[3]) || 2042;
    
    console.log(`Запуск MRIM CLI Клиента...`);
    
    try {
        const redirect = await connectToRedirector(host, port);
        if (redirect) {
            console.log(`[INFO] Перенаправление на: ${redirect}`);
            const parts = redirect.trim().split(':');
            connectToMainServer(parts[0], parseInt(parts[1]) || 2041);
        } else {
            throw new Error('Пустой ответ');
        }
    } catch (err) {
        console.warn(`[WARN] Ошибка: ${err.message}. Пробуем порт 2041...`);
        connectToMainServer(host, 2041);
    }
}

start();