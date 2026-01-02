const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    PermissionsBitField,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags 
} = require("discord.js");
const { joinVoiceChannel } = require('@discordjs/voice');
const mongoose = require('mongoose');

// MongoDB Bağlantısı
mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log("✅ MongoDB Bağlantısı Başarılı!"))
    .catch(err => console.error("❌ MongoDB Bağlantı Hatası:", err));

// ==========================================
// 1. MONGODB MODELLERİ (ŞEMALAR)
// ==========================================

const UserNote = mongoose.model('UserNote', new mongoose.Schema({
    userID: String,
    notes: [
        {
            yazar: String,
            icerik: String,
            tarih: String
        }
    ]
}));

const ActiveVMute = mongoose.model('ActiveVMute', new mongoose.Schema({
    guildID: String,
    userID: String,
    endTime: Number
}));

const Ihlal = mongoose.model('Ihlal', new mongoose.Schema({
    userID: { type: String, unique: true },
    toplamPuan: { type: Number, default: 0 },
    ihlalSayisi: { type: Number, default: 0 },
    gecmis: [{ tip: String, yetkili: String, sebep: String, puan: Number, tarih: Number }]
}));

const ActiveJail = mongoose.model('ActiveJail', new mongoose.Schema({
    guildID: String,
    userID: String,
    savedRoles: [String],
    endTime: Number,
    reason: String,
    staff: String
}));

const Marriage = mongoose.model('Marriage', new mongoose.Schema({
    userID: { type: String, unique: true },
    partnerID: String,
    date: { type: Number, default: Date.now }
}));

const Staff = mongoose.model('Staff', new mongoose.Schema({
    userID: { type: String, unique: true },
    total: { type: Number, default: 0 },
    ban: { type: Number, default: 0 },
    jail: { type: Number, default: 0 },
    mute: { type: Number, default: 0 },
    vmute: { type: Number, default: 0 },
    kick: { type: Number, default: 0 }
}));

// ==========================================
// 2. AYARLAR
// ==========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const prefix = "."; 
const CEZA_LIMITI = 100;
const OTO_JAIL_SURESI = "7d";
const ROLES = {
    JAIL_ROL: "1411088827556171935",
    MARRIAGE: "1452332706456404051"
};

let lastDeleted = new Map(); // Snipe hala RAM'de kalabilir (Hız için)

// ==========================================
// 3. YARDIMCI FONKSİYONLAR (MONGODB UYUMLU)
// ==========================================

function parseDuration(time) {
    const match = time?.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const num = parseInt(match[1]);
    const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return num * units[match[2]];
}

// --- İHLAL EKLEME (MONGO) ---
async function addIhlal(userId, tip, yetkili, sebep, puan) {
    let data = await Ihlal.findOne({ userID: userId });
    if (!data) data = new Ihlal({ userID: userId });

    data.ihlalSayisi += 1;
    data.toplamPuan += puan;
    data.gecmis.push({ tip, yetkili, sebep, puan, tarih: Math.floor(Date.now() / 1000) });

    await data.save();
    return data.toplamPuan;
}

// --- YETKİLİ STAT EKLEME (MONGO) ---
async function addStaffStat(staffId, type) {
    const update = { $inc: { total: 1, [type.toLowerCase()]: 1 } };
    await Staff.findOneAndUpdate({ userID: staffId }, update, { upsert: true });
}

// --- OTOMATİK JAIL KONTROLÜ (MONGO) ---
async function checkAutoJail(message, targetMember, currentScore) {
    if (currentScore >= CEZA_LIMITI) {
        // Puan düşür
        await Ihlal.findOneAndUpdate(
            { userID: targetMember.id }, 
            { $inc: { toplamPuan: -CEZA_LIMITI } }
        );

        const durationMs = parseDuration(OTO_JAIL_SURESI);
        const savedRoles = targetMember.roles.cache
            .filter(r => r.id !== message.guild.id && r.id !== ROLES.JAIL_ROL)
            .map(r => r.id);

        // Rolleri ayarla
        await targetMember.roles.set([ROLES.JAIL_ROL]).catch(() => {});

        // Veritabanına kaydet
        await ActiveJail.create({
            guildID: message.guild.id,
            userID: targetMember.id,
            savedRoles: savedRoles,
            endTime: Date.now() + durationMs,
            reason: "OTOMATİK: Ceza Puanı Limiti",
            staff: "SİSTEM"
        });

        const logEmbed = new EmbedBuilder()
            .setTitle("🚫 CEZA PUANI LİMİTİ AŞILDI!")
            .setColor("DarkRed")
            .setDescription(`**${targetMember.user.tag}** limit aştığı için otomatik cezalandırıldı.`)
            .setTimestamp();

        message.channel.send({ embeds: [logEmbed] });
        return true;
    }
    return false;
}

// ==========================================
// 4. EVENTLER VE DÖNGÜLER
// ==========================================

client.on("ready", async () => { // <--- Buradaki 'async' kelimesi hayati önem taşır
    console.log(`${client.user.tag} olarak giriş yapıldı!`);

    // MongoDB süresi dolan cezaları kontrol eden döngü
    setInterval(async () => { // <--- setInterval içindeki fonksiyon da 'async' olmalı
        const now = Date.now();

        try {
            // 1. Süresi dolan Jail'leri bul ve aç
            const expiredJails = await ActiveJail.find({ endTime: { $lte: now } });
            for (const jail of expiredJails) {
                const guild = client.guilds.cache.get(jail.guildID);
                if (guild) {
                    const member = await guild.members.fetch(jail.userID).catch(() => null);
                    if (member) {
                        await member.roles.set(jail.savedRoles).catch(() => {});
                    }
                }
                await ActiveJail.deleteOne({ _id: jail._id });
            }

            // 2. Süresi dolan VMute'ları bul ve aç
            const expiredVmutes = await ActiveVMute.find({ endTime: { $lte: now } });
            for (const mute of expiredVmutes) {
                const guild = client.guilds.cache.get(mute.guildID);
                if (guild) {
                    const member = await guild.members.fetch(mute.userID).catch(() => null);
                    if (member && member.voice.channel) {
                        await member.voice.setMute(false).catch(() => {});
                    }
                }
                await ActiveVMute.deleteOne({ _id: mute._id });
            }
        } catch (err) {
            console.error("Zamanlayıcı hatası:", err);
        }
    }, 30000); // 30 saniyede bir kontrol eder
});

client.on("messageDelete", message => {
    if (!message.guild || message.author?.bot) return;
    lastDeleted.set(message.channel.id, { 
        content: message.content, 
        author: message.author.tag, 
        time: Date.now() 
    });
});

client.on("messageCreate", async (message) => { // <--- Buraya 'async' gelmeli
    if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const cmd = args.shift()?.toLowerCase();
    const member = message.member;
    const isYonetici = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const isSahip = message.author.id === OZEL_SAHIP_ID;

    // ==========================================
    // BAN KOMUTU
    // ==========================================
    if (cmd === "ban") {
        if (!member.roles.cache.has(ROLES.BAN_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const reason = args.slice(1).join(" ") || "Sebep Yok";
        
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");
        if (!target.bannable) return message.reply("❌ Bu kullanıcıyı banlayamam.");

        await target.ban({ reason });
        
        // MongoDB İşlemleri
        const newScore = await addIhlal(target.id, "BAN", message.author.tag, reason, CEZA_PUANLARI.BAN);
        await addStaffStat(message.author.id, "ban");
        
        message.reply(`🚨 **${target.user.tag}** yasaklandı. Puan: +${CEZA_PUANLARI.BAN} (Toplam: ${newScore})`);
        sendLog("BAN", target.user, message.author, reason, null, CEZA_PUANLARI.BAN);
    }

    // ==========================================
    // UNBAN KOMUTU
    // ==========================================
    if (cmd === "unban") {
        if (!member.roles.cache.has(ROLES.BAN_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const userId = args[0];
        if (!userId) return message.reply("❌ Bir ID girmelisin.");

        try {
            const ban = await message.guild.bans.fetch(userId);
            if (!ban) return message.reply("⚠️ Bu kullanıcı zaten yasaklı değil.");

            await message.guild.members.unban(userId, `Yetkili: ${message.author.tag}`);
            message.reply(`✅ **${ban.user.tag}** yasağı kaldırıldı.`);
        } catch (e) {
            message.reply("❌ Kullanıcı bulunamadı veya hata oluştu.");
        }
    }

    // ==========================================
    // KICK KOMUTU
    // ==========================================
    if (cmd === "kick") {
        if (!member.roles.cache.has(ROLES.KICK_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const reason = args.slice(1).join(" ") || "Sebep Yok";
        
        if (!target || !target.kickable) return message.reply("❌ Kullanıcı bulunamadı veya atılamıyor.");

        await target.kick(reason);
        
        // MongoDB İşlemleri
        const newScore = await addIhlal(target.id, "KICK", message.author.tag, reason, CEZA_PUANLARI.KICK);
        await addStaffStat(message.author.id, "kick");

        message.reply(`👞 **${target.user.tag}** atıldı. Puan: +${CEZA_PUANLARI.KICK} (Toplam: ${newScore})`);
        sendLog("KICK", target.user, message.author, reason, null, CEZA_PUANLARI.KICK);
    }

    // ==========================================
    // MUTE / UNMUTE KOMUTLARI
    // ==========================================
    if (cmd === "mute") {
        if (!member.roles.cache.has(ROLES.MUTE_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const timeInput = args[1];
        const reason = args.slice(2).join(" ") || "Sebep Yok";

        if (!target || !timeInput) return message.reply("❌ Kullanım: `.mute @user 10m Sebep` ");
        const duration = parseDuration(timeInput);

        await target.timeout(duration, reason);
        
        const newScore = await addIhlal(target.id, "MUTE", message.author.tag, reason, CEZA_PUANLARI.MUTE);
        await addStaffStat(message.author.id, "mute");

        message.reply(`🤐 **${target.user.tag}** susturuldu (${timeInput}). Puan: +${CEZA_PUANLARI.MUTE} (Toplam: ${newScore})`);
        await checkAutoJail(message, target, newScore);
        sendLog("MUTE", target.user, message.author, reason, timeInput, CEZA_PUANLARI.MUTE);
    }

    if (cmd === "unmute") {
        if (!member.roles.cache.has(ROLES.MUTE_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");
        
        await target.timeout(null);
        message.reply(`✅ **${target.user.tag}** susturması kaldırıldı.`);
    }

    // ==========================================
    // VMUTE / VUNMUTE KOMUTLARI
    // ==========================================
    if (cmd === "vmute") {
        if (!member.roles.cache.has(ROLES.VMUTE_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const timeInput = args[1];
        const reason = args.slice(2).join(" ") || "Sebep Yok";

        if (!target || !timeInput) return message.reply("❌ Kullanım: `.vmute @user 10m Sebep` ");
        const duration = parseDuration(timeInput);

        // Sesteyse sustur
        if (target.voice.channel) await target.voice.setMute(true).catch(() => {});

        // MongoDB'ye Aktif VMute Kaydet
        await ActiveVMute.findOneAndUpdate(
            { userID: target.id, guildID: message.guild.id },
            { endTime: Date.now() + duration },
            { upsert: true }
        );

        const newScore = await addIhlal(target.id, "VMUTE", message.author.tag, reason, CEZA_PUANLARI.VMUTE);
        await addStaffStat(message.author.id, "vmute");

        message.reply(`🔇 **${target.user.tag}** ses cezası aldı (${timeInput}). Puan: +${CEZA_PUANLARI.VMUTE} (Toplam: ${newScore})`);
        
        // Otomatik açılması için timer (Opsiyonel: setInterval zaten kontrol ediyor)
        setTimeout(async () => {
            const data = await ActiveVMute.findOne({ userID: target.id });
            if (data && Date.now() >= data.endTime) {
                if (target.voice.channel) await target.voice.setMute(false).catch(() => {});
                await ActiveVMute.deleteOne({ userID: target.id });
            }
        }, duration);

        await checkAutoJail(message, target, newScore);
        sendLog("VMUTE", target.user, message.author, reason, timeInput, CEZA_PUANLARI.VMUTE);
    }

    if (cmd === "vunmute") {
        if (!member.roles.cache.has(ROLES.VMUTE_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");

        if (target.voice.channel) await target.voice.setMute(false).catch(() => {});
        await ActiveVMute.deleteOne({ userID: target.id, guildID: message.guild.id });

        message.reply(`✅ **${target.user.tag}** ses susturması kaldırıldı.`);
    }
});

// [JAIL & UNJAIL]
    if (cmd === "jail") {
        if (!member.roles.cache.has(ROLES.JAIL_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const timeInput = args[1];
        const reason = args.slice(2).join(" ") || "Sebep Belirtilmedi";
        
        if (!target || !timeInput) return message.reply("❌ Kullanım: `.jail @kullanıcı 1h Küfür` ");
        const duration = parseDuration(timeInput);

        const savedRoles = target.roles.cache.filter(r => r.id !== message.guild.id && r.id !== ROLES.JAIL_ROL).map(r => r.id);
        
        // Rolleri Ayarla
        await target.roles.set([ROLES.JAIL_ROL]);

        // MongoDB Kaydı
        await ActiveJail.findOneAndUpdate(
            { userID: target.id, guildID: message.guild.id },
            { savedRoles, endTime: Date.now() + duration, reason, staff: message.author.id },
            { upsert: true }
        );

        const newScore = await addIhlal(target.id, "JAIL", message.author.tag, reason, CEZA_PUANLARI.JAIL);
        await addStaffStat(message.author.id, "jail");

        message.reply(`🚨 **${target.user.tag}** jaillendi (${timeInput}). Puan: +${CEZA_PUAN_LARI.JAIL} (Toplam: ${newScore})`);
        sendLog("JAIL", target.user, message.author, reason, timeInput, CEZA_PUANLARI.JAIL);
    }

    if (cmd === "unjail") {
        if (!member.roles.cache.has(ROLES.JAIL_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");

        const jailData = await ActiveJail.findOne({ userID: target.id, guildID: message.guild.id });
        if (jailData) {
            await target.roles.set(jailData.savedRoles).catch(() => {});
            await ActiveJail.deleteOne({ userID: target.id });
            message.reply("✅ Jail başarıyla kaldırıldı.");
        } else {
            message.reply("⚠️ Kullanıcı veritabanında jailde görünmüyor.");
        }
    }

 // [PUAN SIL]
    if (cmd === "puansil" || cmd === "puan-sil") {
        if (!member.roles.cache.has(ROLES.PUAN_SIL_YETKILI) && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const miktar = parseInt(args[1]);
        if (!target || isNaN(miktar)) return message.reply("❌ Kullanım: `.puansil @üye 15` ");

        const data = await Ihlal.findOneAndUpdate(
            { userID: target.id },
            { $inc: { toplamPuan: -miktar } },
            { new: true, upsert: true }
        );
        if (data.toplamPuan < 0) { data.toplamPuan = 0; await data.save(); }

        const logChannel = client.channels.cache.get("1434659021519847434");
        if (logChannel) {
            const pSilEmbed = new EmbedBuilder()
                .setTitle("📉 Ceza Puanı Düşürüldü")
                .setColor("Blue")
                .addFields(
                    { name: "👤 Kullanıcı", value: `${target} (\`${target.id}\`)`, inline: true },
                    { name: "👮 Yetkili", value: `${message.author}`, inline: true },
                    { name: "📉 Silinen Miktar", value: `\`${miktar}\` Puan`, inline: true },
                    { name: "📊 Yeni Puan", value: `**${data.toplamPuan}**`, inline: true }
                ).setTimestamp();
            logChannel.send({ embeds: [pSilEmbed] });
        }
        message.reply(`✅ **${target.user.tag}** puanı düşürüldü. Yeni Puan: **${data.toplamPuan}**`);
    }

    // [SICIL TEMIZLE]
    if (cmd === "siciltemizle") {
        if (!isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");

        await Ihlal.deleteOne({ userID: target.id });
        message.reply(`✅ **${target.user.tag}** sicili tamamen sıfırlandı.`);
    }

    // [SICIL / BAK] - 1411088827581337740
    if (cmd === "sicil" || cmd === "bak") {
        const sicilYetki = member.roles.cache.has("1411088827581337740") || isYonetici || isSahip;
        if (!sicilYetki) return message.reply("❌ Yetkiniz yok.");
        const target = await getMember(message.guild, args[0]) || message.member;

        let db = loadData('ihlal_takip.json');
        let notesDb = loadData('user_notes.json');
        const guardLog = db[target.id] || { ihlalSayisi: 0, toplamPuan: 0, gecmis: [] };
        const notlar = notesDb[target.id] || [];
        const puan = guardLog.toplamPuan || 0;

        const percentage = Math.min((puan / CEZA_LIMITI) * 10, 10);
        const progressBar = "🟥".repeat(Math.floor(percentage)) + "⬜".repeat(10 - Math.floor(percentage));

        const sicilEmbed = new EmbedBuilder()
            .setAuthor({ name: `${target.user.tag} - Sicil Kaydı`, iconURL: target.user.displayAvatarURL() })
            .setColor(puan >= 50 ? "Red" : "Green")
            .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "⚖️ Ceza Puanı", value: `${progressBar} **${puan} / ${CEZA_LIMITI}**`, inline: false },
                { name: "🛡️ İhlal Sayısı", value: `Toplam **${guardLog.ihlalSayisi}** ceza.`, inline: true },
                { name: "📝 Notlar", value: `**${notlar.length}** yetkili notu.`, inline: true }
            );

        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_not_ekle_${target.id}`).setLabel("📝 Not Ekle").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`btn_not_oku_${target.id}`).setLabel("📂 Notlar").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`btn_not_sil_${target.id}`).setLabel("🗑️ Not Sil").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`btn_kapat`).setLabel("✖️ Kapat").setStyle(ButtonStyle.Secondary)
        );
        await message.reply({ embeds: [sicilEmbed], components: [btnRow] });
    }

    // [SIL / TEMIZLE]
    if (cmd === "sil" || cmd === "temizle") {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            return message.reply("❌ Yetkin yok.");
        }
        const miktar = parseInt(args[0]);
        if (isNaN(miktar) || miktar < 1 || miktar > 100) return message.reply("❌ Miktar gir (1-100).");

        await message.channel.bulkDelete(miktar, true).then(msg => {
            message.channel.send(`✅ ${msg.size} mesaj silindi.`).then(m => setTimeout(() => m.delete().catch(()=>{}), 3000));
        });
    }

    // [SNIPE] - 1411088827581337740 ve 1449836927170646237
    if (cmd === "snipe") {
        const snipeYetki = member.roles.cache.has("1411088827581337740") || member.roles.cache.has("1449836927170646237") || isYonetici || isSahip;
        if (!snipeYetki) return message.reply("❌ Yetkin yok.");
        const data = lastDeleted.get(message.channel.id);
        if (!data) return message.reply("✅ Silinen mesaj yok.");
        const embed = new EmbedBuilder().setAuthor({ name: data.author }).setDescription(data.content).setColor("Orange").setTimestamp(data.time);
        message.channel.send({ embeds: [embed] });
    }

// [EVLEN]
    if (cmd === "evlen") {
        const target = message.mentions.members.first();
        if (!target || target.id === message.author.id) return message.reply("❌ Geçerli birini etiketle.");
        
        const checkEvli = await Marriage.findOne({ $or: [{ userID: message.author.id }, { userID: target.id }, { partnerID: message.author.id }, { partnerID: target.id }] });
        if (checkEvli) return message.reply("❌ Taraflardan biri zaten evli!");

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("evet").setLabel("Evet").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("hayır").setLabel("Hayır").setStyle(ButtonStyle.Danger)
        );

        const msg = await message.channel.send({ content: `${target}, ${message.author} seninle evlenmek istiyor!`, components: [row] });
        const collector = msg.createMessageComponentCollector({ filter: i => i.user.id === target.id, time: 30000 });

        collector.on("collect", async i => {
            if (i.customId === "evet") {
                await Marriage.create({ userID: message.author.id, partnerID: target.id, date: Date.now() });
                await i.update({ content: `🎉 **${message.author.username}** ve **${target.user.username}** evlendi!`, components: [] });
                target.roles.add(ROLES.MARRIAGE).catch(() => {});
                message.member.roles.add(ROLES.MARRIAGE).catch(() => {});
            } else {
                await i.update({ content: "❌ Teklif reddedildi.", components: [] });
            }
        });
    }

    // [BOŞAN]
    if (cmd === "boşan") {
        const data = await Marriage.findOne({ $or: [{ userID: message.author.id }, { partnerID: message.author.id }] });
        if (!data) return message.reply("❌ Zaten bekarsın.");

        const partnerId = data.userID === message.author.id ? data.partnerID : data.userID;
        await Marriage.deleteOne({ _id: data._id });
        
        const partnerMember = await message.guild.members.fetch(partnerId).catch(() => null);
        if (partnerMember) partnerMember.roles.remove(ROLES.MARRIAGE).catch(() => {});
        message.member.roles.remove(ROLES.MARRIAGE).catch(() => {});

        message.reply("💔 Başarıyla boşandınız.");
    }

    // [EVLİLİK / SHIP]
    if (cmd === "evlilik" || cmd === "ship") {
        const target = await getMember(message.guild, args[0]) || message.member;
        const data = await Marriage.findOne({ $or: [{ userID: target.id }, { partnerID: target.id }] });

        if (!data) return message.reply(`❌ **${target.user.tag}** şu an bekar.`);

        const partnerID = data.userID === target.id ? data.partnerID : data.userID;
        const partner = await client.users.fetch(partnerID).catch(() => null);
        const tarih = Math.floor(data.date / 1000);

        const shipEmbed = new EmbedBuilder()
            .setTitle("💍 Evlilik Cüzdanı")
            .setColor("LuminousVividPink")
            .setDescription(`${target} ❤️ ${partner ? partner : "Bilinmeyen"}\n\n📅 **Evlilik Tarihi:** <t:${tarih}:D> (<t:${tarih}:R>)`)
            .setTimestamp();

        message.channel.send({ embeds: [shipEmbed] });
    }

// [YETKILI STAT]
    if (cmd === "yetkilistat" || cmd === "ystat") {
        const targetStaff = await getMember(message.guild, args[0]) || message.member;
        
        // MongoDB'den yetkili verisini çek
        const s = await Staff.findOne({ userID: targetStaff.id });

        if (!s) return message.reply("⚠️ Bu yetkilinin henüz bir işlem kaydı bulunmuyor.");

        const embed = new EmbedBuilder()
            .setTitle(`📊 Yetkili İstatistikleri: ${targetStaff.user.username}`)
            .setColor("Blue")
            .setThumbnail(targetStaff.user.displayAvatarURL())
            .setDescription(`${targetStaff} adlı yetkilinin sunucu içerisindeki ceza uygulama verileri aşağıdadır:`)
            .addFields(
                { name: "🔨 Ban", value: `\`${s.ban || 0}\` adet`, inline: true },
                { name: "👞 Kick", value: `\`${s.kick || 0}\` adet`, inline: true },
                { name: "🤐 Mute", value: `\`${s.mute || 0}\` adet`, inline: true },
                { name: "🔇 VMute", value: `\`${s.vmute || 0}\` adet`, inline: true },
                { name: "🚨 Jail", value: `\`${s.jail || 0}\` adet`, inline: true },
                { name: "📈 Toplam İşlem", value: `**${s.total || 0}**`, inline: false }
            )
            .setFooter({ text: "İstatistikler MongoDB üzerinden anlık çekilmektedir." })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    // [TOP STAT]
    if (cmd === "topstat") {
        // MongoDB'den en yüksek 'total'e sahip 10 yetkiliyi çek
        const topStaff = await Staff.find().sort({ total: -1 }).limit(10);

        if (topStaff.length === 0) return message.reply("Henüz kaydedilmiş bir yetkili verisi bulunamadı.");

        let desc = "";
        topStaff.forEach((data, index) => {
            desc += `**${index + 1}.** <@${data.userID}> | Toplam: \`${data.total}\` işlem\n`;
        });

        const embed = new EmbedBuilder()
            .setTitle("🏆 En Aktif Yetkililer (Top 10)")
            .setColor("Gold")
            .setDescription(desc || "Veri yok.")
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

// [HELP / YARDIM]
    if (cmd === "help" || cmd === "yardım") {
        const isUserYonetici = member.permissions.has(PermissionsBitField.Flags.Administrator);
        const isUserYetkili = member.roles.cache.has(ROLES.JAIL_YETKILI) || member.roles.cache.has(ROLES.MUTE_YETKILI);

        const helpEmb = new EmbedBuilder()
            .setAuthor({ name: `${client.user.username} Yardım Menüsü`, iconURL: client.user.displayAvatarURL() })
            .setColor("Gold")
            .setThumbnail(client.user.displayAvatarURL())
            .setDescription(
                `Merhaba **${message.author.username}**, sunucu yönetim ve ceza sistemi komutları aşağıda listelenmiştir.\n` +
                `⚠️ **Ceza Limiti:** \`${CEZA_LIMITI}\` puan (Dolunca otomatik 1 hafta Jail).`
            )
            .addFields(
                { 
                    name: "👤 Kullanıcı Komutları", 
                    value: 
                    "`.evlen @üye` - Belirttiğiniz kişiyle evlenirsiniz.\n" +
                    "`.boşan` - Mevcut evliliğinizi bitirirsiniz.\n" +
                    "`.evlilik [@üye]` - Evlilik durumunu gösterir.\n" +
                    "`.yardım` - Bu menüyü açar.\n" +
                    "`.snipe` - Son silinen mesajı gösterir."
                }
            );

        if (isUserYetkili || isUserYonetici) {
            helpEmb.addFields({ 
                name: "🛡️ Yetkili Komutları", 
                value: 
                "`.sicil [@üye]` - Sicil/puan durumunu gösterir.\n" +
                "`.mute @üye [süre] [sebep]` - Chat susturma.\n" +
                "`.vmute @üye [süre] [sebep]` - Ses susturma.\n" +
                "`.jail @üye [süre] [sebep]` - Karantinaya alma.\n" +
                "`.ban @üye [sebep]` - Yasaklama.\n" +
                "`.unban [ID]` - Yasak kaldırma.\n" +
                "`.kick @üye [sebep]` - Sunucudan atma.\n" +
                "`.puansil @üye [miktar]` - Puan düşürme.\n" +
                "`.ystat [@yetkili]` - Yetkili istatistiği.\n" +
                "`.topstat` - Yetkili sıralaması."
            });
        }

        if (isUserYonetici || isSahip) {
            helpEmb.addFields({ 
                name: "⚙️ Yönetici Komutları", 
                value: 
                "`.siciltemizle @üye` - Sicili sıfırlar.\n" +
                "`.katıl` - Botu sese çeker.\n" +
                "`.sil [1-100]` - Mesaj temizler."
            });
        }

        // Puan Tablosu Dinamik Hale Getirildi
        helpEmb.addFields({ 
            name: "📊 Puan Tablosu", 
            value: `💬 Mute: \`+${CEZA_PUANLARI.MUTE}\` | 🎙️ VMute: \`+${CEZA_PUANLARI.VMUTE}\` | ⚖️ Jail: \`+${CEZA_PUANLARI.JAIL}\` | 👞 Kick: \`+${CEZA_PUANLARI.KICK}\` | 🚫 Ban: \`+${CEZA_PUANLARI.BAN}\``
        });

        helpEmb.setFooter({ text: `${message.author.tag} tarafından istendi.`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
            .setTimestamp();

        message.channel.send({ embeds: [helpEmb] });
    }

    // DİĞER KOMUTLAR (EVLEN, BOŞAN, SİL, KATIL, SICILTEMIZLE) DEĞİŞMEDEN DEVAM EDER...
    // [KATIL]
    if (cmd === "katıl") {
        if (!isYonetici && !isSahip) return message.reply("❌ Sadece yönetici.");
        const channel = message.member.voice.channel;
        if (!channel) return;
        joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator });
        message.reply("🔊 Bağlandım.");
    }
});

// ==========================================
// 5. ETKİLEŞİM YÖNETİMİ (MONGODB)
// ==========================================
client.on("interactionCreate", async interaction => {
    if (interaction.isButton()) {
        const parts = interaction.customId.split("_");
        if (interaction.customId === "btn_kapat") return interaction.message.delete().catch(() => {});

        if (parts[0] !== "btn" || parts[1] !== "not") return;
        const operasyon = parts[2];
        const targetId = parts[3];

        const ozelYetkili = interaction.user.id === NOT_YETKILISI_ID || 
                           interaction.member.roles.cache.has(NOT_YETKILISI_ID) || 
                           interaction.user.id === OZEL_SAHIP_ID || 
                           interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

        if (!ozelYetkili) return interaction.reply({ content: "❌ Sadece sicil yetkilileri.", flags: MessageFlags.Ephemeral });

        if (operasyon === "ekle") {
            const modal = new ModalBuilder().setCustomId(`modal_not_kayit_${targetId}`).setTitle("Kullanıcıya Not Ekle");
            const notInput = new TextInputBuilder().setCustomId("not_icerik").setLabel("Notunuzu yazın").setStyle(TextInputStyle.Paragraph).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(notInput));
            await interaction.showModal(modal);
        }

        if (operasyon === "oku") {
            const data = await UserNote.findOne({ userID: targetId });
            const notlar = data ? data.notes : [];
            let notMetni = notlar.length > 0 ? notlar.map((n, i) => `**${i + 1}.** \`${n.tarih}\` (<@${n.yazar}>): ${n.icerik}`).join("\n\n") : "📜 Not yok.";
            
            if (notMetni.length > 4000) notMetni = notMetni.substring(0, 4000) + "...";
            const notEmbed = new EmbedBuilder().setTitle(`📂 <@${targetId}> - Notlar`).setColor("Blurple").setDescription(notMetni);
            await interaction.reply({ embeds: [notEmbed], flags: MessageFlags.Ephemeral });
        }

        if (operasyon === "sil") {
            const data = await UserNote.findOne({ userID: targetId });
            const notlar = data ? data.notes : [];
            if (notlar.length === 0) return interaction.reply({ content: "Silinecek not yok.", flags: MessageFlags.Ephemeral });

            const selectMenu = new StringSelectMenuBuilder().setCustomId(`select_not_sil_${targetId}`).setPlaceholder('Silinecek notu seçin...');
            notlar.slice(-25).map((n, index) => { // Discord select menü sınırı 25'tir
                selectMenu.addOptions(new StringSelectMenuOptionBuilder()
                    .setLabel(`${index + 1}. Not (${n.tarih})`)
                    .setDescription(n.icerik.substring(0, 50) + "...")
                    .setValue(index.toString())
                );
            });

            await interaction.reply({ content: "🗑️ Silinecek notu seçin (Son 25 not listelenir):", components: [new ActionRowBuilder().addComponents(selectMenu)], flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_not_kayit")) {
        const targetId = interaction.customId.split("_")[3];
        const icerik = interaction.fields.getTextInputValue("not_icerik");

        await UserNote.findOneAndUpdate(
            { userID: targetId },
            { 
                $push: { 
                    notes: { yazar: interaction.user.id, icerik: icerik, tarih: new Date().toLocaleDateString("tr-TR") } 
                } 
            },
            { upsert: true }
        );

        await interaction.reply({ content: `✅ **Not sicile eklendi!**`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("select_not_sil_")) {
        const targetId = interaction.customId.split("_")[3];
        const secilenIndex = parseInt(interaction.values[0]);

        const data = await UserNote.findOne({ userID: targetId });
        if (data && data.notes[secilenIndex]) {
            data.notes.splice(secilenIndex, 1);
            await data.save();
            await interaction.update({ content: `✅ **Not başarıyla silindi!**`, components: [], embeds: [] });
        } else { 
            await interaction.update({ content: "❌ Hata oluştu veya not bulunamadı.", components: [] }); 
        }
    }
});

// ==========================================
// 6. EXPRESS SERVER & BOT BASLATMA
// ==========================================

const express = require('express');
const app = express();
const port = 3100;//buraya karışmayın.

app.get('/', (req, res) => res.send('we discord'));//değiştirebilirsiniz.

app.listen(port, () =>
console.log(`Bot bu adres üzerinde çalışıyor: http://localhost:${port}`)//port
);

// --- BOTU LOGIN ET ---
client.login(process.env.TOKEN).catch(e => {
    console.error("❌ Token Hatası: Bot başlatılamadı!");
    console.error(e);
});

// ==========================================
// 7. ANTI-CRASH (BOTUN ÇÖKMESİNİ ENGELLER)
// ==========================================

process.on('unhandledRejection', (reason, p) => {
    console.log('⚠️ [Hata Yakalandı] - Unhandled Rejection:', reason);
});

process.on("uncaughtException", (err, origin) => {
    console.log('⚠️ [Hata Yakalandı] - Uncaught Exception:', err);
});

process.on('uncaughtExceptionMonitor', (err, origin) => {
    console.log('⚠️ [Hata Yakalandı] - Exception Monitor:', err);
});





