const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'www')));

let ilanHavuzu = [];
let durumBilgisi = { bagli: false, kod: null, kodUretildi: false };
let sock = null;

function numaraTemizle(tel) {
    let rakam = String(tel || '').replace(/\D/g, '');
    if (rakam.startsWith('0')) rakam = '9' + rakam;
    if (!rakam.startsWith('90') && rakam.length === 10) rakam = '90' + rakam;
    return rakam;
}

function numaraAyikla(gonderenTel, mesajMetni) {
    const icerikTel = (mesajMetni || '').match(/(05\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}|5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2})/);
    if (icerikTel) return icerikTel.replace(/\D/g, '').slice(-10);
    return (gonderenTel || '').replace(/\D/g, '').slice(-10);
}

async function whatsappMotoruBaslat(telefonNo = null) {
    const { state, saveCreds } = await useMultiFileAuthState('./telefon_oturumu');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Grupaj App', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    // Sabit 8 Haneli Şifre Üretimi (Değişmez)
    if (telefonNo && !sock.authState.creds.registered && !durumBilgisi.kodUretildi) {
        durumBilgisi.kodUretildi = true;
        setTimeout(async () => {
            try {
                const kod = await sock.requestPairingCode(telefonNo);
                durumBilgisi.kod = kod;
            } catch (e) {
                durumBilgisi.kodUretildi = false;
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            durumBilgisi = { bagli: true, kod: null, kodUretildi: false };
        } else if (connection === 'close') {
            durumBilgisi.bagli = false;
            const tekrarBaglan = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (tekrarBaglan) whatsappMotoruBaslat();
        }
    });

    // Canlı İlan Yakalayıcı (Grup / Kanal / Durum)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (!msg.message) continue;
                const metin = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if (!metin.trim()) continue;

                const jid = msg.key.remoteJid || '';
                let veriTipi = '';
                let kaynakIsmi = '';

                if (jid.endsWith('@g.us')) {
                    veriTipi = 'Grup';
                    const meta = await sock.groupMetadata(jid).catch(() => null);
                    kaynakIsmi = meta?.subject || 'Nakliye Grubu';
                } else if (jid.endsWith('@newsletter')) {
                    veriTipi = 'Kanal';
                    kaynakIsmi = msg.pushName || 'Nakliye Kanalı';
                } else if (jid === 'status@broadcast') {
                    veriTipi = 'Durum';
                    const gonderen = (msg.key.participant || '').split('@');
                    kaynakIsmi = gonderen ? `+${gonderen}` : 'Durum';
                }

                if (veriTipi !== '') {
                    const temizMesaj = metin.trim();
                    const gonderenHam = (msg.key.participant || jid).split('@');
                    const yeniTel = numaraAyikla(gonderenHam, temizMesaj);

                    const mevcutIdx = ilanHavuzu.findIndex(i => {
                        const ayniMetin = i.mesaj === temizMesaj;
                        const eskiTel = numaraAyikla(i.telefon, i.mesaj);
                        return ayniMetin && ((yeniTel && eskiTel) ? yeniTel === eskiTel : true);
                    });

                    if (mevcutIdx !== -1) {
                        const [mevcut] = ilanHavuzu.splice(mevcutIdx, 1);
                        mevcut.tarih = new Date();
                        mevcut.kaynak = kaynakIsmi;
                        ilanHavuzu.unshift(mevcut);
                    } else {
                        ilanHavuzu.unshift({
                            tip: veriTipi,
                            kaynak: kaynakIsmi,
                            mesaj: temizMesaj,
                            telefon: gonderenHam,
                            tarih: new Date()
                        });
                    }
                }
            } catch (e) {}
        }
    });
}

// Arayüz Bağlantı Kapıları
app.post('/api/sifre-al', (req, res) => {
    const tel = numaraTemizle(req.body.telefon);
    if (durumBilgisi.bagli) return res.json({ durum: 'bagli', telefon: tel });
    whatsappMotoruBaslat(tel);
    res.json({ durum: 'bekleniyor', telefon: tel });
});

app.get('/api/durum/:telefon', (req, res) => {
    res.json({ bagli: durumBilgisi.bagli, kod: durumBilgisi.kod });
});

app.get('/api/ilanlar/:telefon', (req, res) => {
    res.json(ilanHavuzu);
});

// 10 Saatlik Otomatik Temizlik
setInterval(() => {
    const onSaatOncesi = new Date(Date.now() - 10 * 60 * 60 * 1000);
    ilanHavuzu = ilanHavuzu.filter(i => new Date(i.tarih) > onSaatOncesi);
}, 60000);

app.listen(PORT, () => {
    console.log(`📱 Telefon İçi Motor Hazır: http://localhost:${PORT}`);
    whatsappMotoruBaslat();
});
