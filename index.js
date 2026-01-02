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
const fs = require('fs');

// ==========================================
// 1. AYARLAR VE TANIMLAMALAR
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

// --- GENEL AYARLAR ---
const prefix = "."; 
const OZEL_SAHIP_ID = "983015347105976390"; // Buraya kendi ID'ni yaz
const NOT_YETKILISI_ID = "1411088827581337742"; 

// --- CEZA PUANLARI ---
const CEZA_PUANLARI = {
    MUTE: 5,    
    VMUTE: 8,   
    JAIL: 15,   
    KICK: 20,   
    BAN: 40     
};

const CEZA_LIMITI = 100; // Bu puana ulaşan otomatik jail yer
const OTO_JAIL_SURESI = "7d"; // 1 Hafta

// --- ROL AYARLARI ---
const ROLES = {
    BAN_YETKILI: "1411088827598110852",
    KICK_YETKILI: "1411088827589595266",
    MUTE_YETKILI: "1411088827581337740",
    SICIL_YETKILI: "1411088827581337740",
    VMUTE_YETKILI: "1411088827581337734",
    JAIL_YETKILI: "1411088827581337742",
    SNIPE_ROLLER: ["1411088827581337740", "1449836927170646237"],
    PUAN_SIL_YETKILI: "1411088827589595258",
    JAIL_ROL: "1411088827556171935", // Jail'e atılanlara verilecek rol
    MARRIAGE: "1452332706456404051"
};

// ==========================================
// 2. VERİ YÖNETİMİ (DATABASE)
// ==========================================

// Gerekli dosyalar yoksa oluştur (Crash önleyici)
const requiredFiles = [
    'evliUsers.json', 'activeJails.json', 'jailHistory.json', 
    'vmuteHistory.json', 'activeVmutes.json', 'user_notes.json', 'ihlal_takip.json'
];

requiredFiles.forEach(file => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify({}));
        console.log(`📂 Oluşturuldu: ${file}`);
    }
});

// Veri Okuma/Yazma Yardımcıları
const saveData = (fileName, data) => fs.writeFileSync(fileName, JSON.stringify(data, null, 2));
const loadData = (fileName) => {
    try {
        if (fs.existsSync(fileName)) {
            const data = fs.readFileSync(fileName, 'utf8');
            return data ? JSON.parse(data) : {};
        }
    } catch (e) { console.error(`${fileName} yüklenirken hata:`, e); }
    return {};
};

// Bellekte tutulacak veriler (Dosyadan yüklenir)
let evliUsers = new Map(Object.entries(loadData('evliUsers.json')));
let activeJails = loadData('activeJails.json');
let lastDeleted = new Map(); // Snipe için RAM'de tutulur

// ==========================================
// 3. YARDIMCI FONKSİYONLAR
// ==========================================

function parseDuration(time) {
    const match = time?.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const num = parseInt(match[1]);
    const unit = match[2];
    if (unit === "s") return num * 1000;
    if (unit === "m") return num * 60000;
    if (unit === "h") return num * 3600000;
    if (unit === "d") return num * 86400000;
}

const getMember = async (guild, idOrMention) => {
    if (!idOrMention) return null;
    const id = idOrMention.replace(/[<@!>]/g, "");
    return await guild.members.fetch(id).catch(() => null);
};

// --- [ÖNEMLİ] GÜNCELLENMİŞ PUAN SİSTEMİ ---
// Her işlemde dosyayı yeniden okur, veri kaybını önler.
function addIhlal(userId, tip, yetkili, sebep, puan) {
    let db = loadData('ihlal_takip.json'); // Anlık oku

    if (!db[userId]) db[userId] = { toplamPuan: 0, ihlalSayisi: 0, gecmis: [] };

    db[userId].ihlalSayisi += 1;
    db[userId].toplamPuan = (db[userId].toplamPuan || 0) + puan;

    db[userId].gecmis.push({
        tip: tip,
        yetkili: yetkili,
        sebep: sebep,
        puan: puan,
        tarih: Math.floor(Date.now() / 1000)
    });

    saveData('ihlal_takip.json', db); // Anlık yaz
    return db[userId].toplamPuan;
}

function getUserBadges(member, puan) {
    let rozetler = "";
    if (puan === 0) rozetler += "😇 **Temiz Sicil**\n";
    if (puan > 0 && puan < 50) rozetler += "⚠️ **Sabıkalı**\n";
    if (puan >= 50 && puan < 100) rozetler += "🟠 **Yüksek Riskli**\n";
    if (puan >= 100) rozetler += "💀 **Limit Aşımı (Auto-Jail)**\n";
    if (member.roles.cache.has(ROLES.MARRIAGE)) rozetler += "💍 **Evli**\n";
    return rozetler || "Yok";
}

// --- LOG GÖNDERME SİSTEMİ ---
async function sendLog(type, target, staff, reason, duration = null, score = null) {
    const logChannelId = "1434659021519847434"; // Senin belirttiğin kanal
    const logChannel = client.channels.cache.get(logChannelId);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
        .setTitle(`📝 Ceza İşlemi: ${type}`)
        .setColor(type === "BAN" ? "DarkRed" : type === "JAIL" ? "Red" : "Orange")
        .addFields(
            { name: "👤 Kullanıcı", value: `${target} (\`${target.id}\`)`, inline: true },
            { name: "👮 Yetkili", value: `${staff}`, inline: true },
            { name: "⚖️ Ceza Puanı", value: score ? `+${score}` : "Yok", inline: true },
            { name: "📝 Sebep", value: reason || "Belirtilmedi" }
        )
        .setTimestamp();

    if (duration) embed.addFields({ name: "⏳ Süre", value: duration, inline: true });

    logChannel.send({ embeds: [embed] });
}

// --- YETKİLİ STAT KAYDI ---
function addStaffStat(staffId, type) {
    let stats = loadData('staff_stats.json');
    if (!stats[staffId]) stats[staffId] = { total: 0, ban: 0, kick: 0, mute: 0, vmute: 0, jail: 0 };

    stats[staffId].total += 1;
    stats[staffId][type.toLowerCase()] += 1;

    saveData('staff_stats.json', stats);
}

// --- OTOMATİK JAIL KONTROLÜ (GÜNCELLENMİŞ) ---
async function checkAutoJail(message, targetMember, currentScore) {
    if (currentScore >= CEZA_LIMITI) {
        // Puan silme işlemi için dosyayı tekrar oku ve yaz
        let db = loadData('ihlal_takip.json');
        db[targetMember.id].toplamPuan = Math.max(0, db[targetMember.id].toplamPuan - CEZA_LIMITI);
        saveData('ihlal_takip.json', db);

        // Jail İşlemi Ayarları
        const duration = parseDuration(OTO_JAIL_SURESI);
        const savedRoles = targetMember.roles.cache
            .filter(r => r.id !== message.guild.id && r.id !== ROLES.JAIL_ROL)
            .map(r => r.id);

        // Rolleri ayarla
        await targetMember.roles.set([ROLES.JAIL_ROL]).catch(e => console.log("Rol hatası:", e));

        const key = `${message.guild.id}_${targetMember.id}`;
        activeJails = loadData('activeJails.json'); // RAM'i tazele
        activeJails[key] = { savedRoles, endTime: Date.now() + duration };
        saveData('activeJails.json', activeJails);

        // Geçmişe İşle (Jail History)
        let jHist = loadData('jailHistory.json');
        if (!jHist[key]) jHist[key] = [];
        jHist[key].push({ 
            startDate: Date.now(), 
            durationStr: OTO_JAIL_SURESI, 
            reason: "OTOMATİK: Ceza Puanı Limiti", 
            staff: "SİSTEM" 
        });
        saveData('jailHistory.json', jHist);

        // 1. KANAL BİLGİLENDİRMESİ (Mesajın atıldığı kanal)
        const autoEmbed = new EmbedBuilder()
            .setTitle("🚫 CEZA PUANI LİMİTİ AŞILDI!")
            .setColor("DarkRed")
            .setDescription(`**${targetMember.user.tag}** adlı kullanıcı **${CEZA_LIMITI}** ceza puanına ulaştığı için otomatik cezalandırıldı.`)
            .addFields(
                { name: "🤖 İşlem", value: `Sistem tarafından **${OTO_JAIL_SURESI}** Jail atıldı.`, inline: true },
                { name: "📉 Puan Durumu", value: `Puanından **${CEZA_LIMITI}** düşüldü.`, inline: true }
            )
            .setTimestamp();

        message.channel.send({ content: `${targetMember}`, embeds: [autoEmbed] });

        // 2. LOG KANALINA GÖNDER (Senin belirttiğin kanal: 1434659021519847434)
        const logChannelId = "1434659021519847434";
        const logChannel = client.channels.cache.get(logChannelId);
        if (logChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle("🤖 Otomatik Jail İşlemi")
                .setColor("DarkRed")
                .addFields(
                    { name: "👤 Kullanıcı", value: `${targetMember} (\`${targetMember.id}\`)`, inline: true },
                    { name: "👮 Yetkili", value: `SİSTEM (Auto-Mod)`, inline: true },
                    { name: "⏳ Süre", value: OTO_JAIL_SURESI, inline: true },
                    { name: "📝 Sebep", value: `Ceza Puanı Limiti (${CEZA_LIMITI}+) Aşıldı.`, inline: false }
                )
                .setTimestamp();
            logChannel.send({ embeds: [logEmbed] });
        }

        // Timer başlat (Süre dolunca otomatik unjail)
        setTimeout(async () => {
            let currentJails = loadData('activeJails.json');
            if (currentJails[key]) {
                try {
                    const memberFetch = await message.guild.members.fetch(targetMember.id).catch(() => null);
                    if (memberFetch) await memberFetch.roles.set(currentJails[key].savedRoles);
                } catch (e) { console.log("Unjail hatası:", e); }

                delete currentJails[key];
                saveData('activeJails.json', currentJails);
            }
        }, duration);

        return true;
    }
    return false;
}

// ==========================================
// 4. EVENTLER
// ==========================================

client.once("clientReady", () => {
    console.log(`✅ ${client.user.tag} ONLINE! - Ceza Puanı Sistemi Aktif.`);

    // Unjail Kontrol Döngüsü
    setInterval(async () => {
        const now = Date.now();
        // Dosyadan taze veri okuyalım ki manuel editlemeler bozulmasın
        activeJails = loadData('activeJails.json'); 

        for (const key in activeJails) {
            if (now >= activeJails[key].endTime) {
                const [guildId, userId] = key.split('_');
                const guild = client.guilds.cache.get(guildId);
                if (!guild) continue;
                try {
                    const member = await guild.members.fetch(userId);
                    if (member) await member.roles.set(activeJails[key].savedRoles);
                } catch (e) {}

                delete activeJails[key];
                saveData('activeJails.json', activeJails);
                console.log(`🔓 Süresi dolan Jail kalktı: ${userId}`);
            }
        }
    }, 60000); // 1 dakikada bir kontrol
});

client.on("messageDelete", message => {
    if (!message.guild || message.author?.bot) return;
    lastDeleted.set(message.channel.id, { content: message.content, author: message.author.tag, time: Date.now() });
});

client.on("messageCreate", async message => {
    if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const cmd = args.shift()?.toLowerCase();
    const member = message.member;
    const isYonetici = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const isSahip = message.author.id === OZEL_SAHIP_ID;

    // [BAN] - 1411088827598110852
    if (cmd === "ban") {
        if (!member.roles.cache.has("1411088827598110852") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const reason = args.slice(1).join(" ") || "Sebep Yok";
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");
        if (!target.bannable) return message.reply("❌ Bu kullanıcıyı banlayamam.");

        await target.ban({ reason });
        const newScore = addIhlal(target.id, "BAN", message.author.tag, reason, CEZA_PUANLARI.BAN);
        message.reply(`🚨 **${target.user.tag}** yasaklandı. Puan: +${CEZA_PUANLARI.BAN} (Toplam: ${newScore})`);

        // BAN komutunun sonuna ekle:
        addStaffStat(message.author.id, "ban");
        sendLog("BAN", target.user, message.author, reason, null, CEZA_PUANLARI.BAN);
    }

    // [UNBAN] - 1411088827598110852
    if (cmd === "unban") {
        // Yetki Kontrolü: Ban Yetkilisi, Yönetici veya Sahip
        if (!member.roles.cache.has("1411088827598110852") && !isYonetici && !isSahip) {
            return message.reply("❌ Bu komutu kullanmak için **Ban Yetkilisi** olman gerekiyor.");
        }

        const userId = args[0];
        if (!userId) return message.reply("❌ Yasağını kaldırmak istediğin kullanıcının **ID**'sini girmelisin. \nKullanım: `.unban 123456789012345678` ");

        try {
            // Sunucudaki yasakları kontrol et
            const banList = await message.guild.bans.fetch();
            const bannedUser = banList.get(userId);

            if (!bannedUser) {
                return message.reply("⚠️ Bu kullanıcı zaten yasaklı değil veya ID yanlış.");
            }

            // Yasağı Kaldır
            await message.guild.members.unban(userId, `Yetkili: ${message.author.tag}`);

            const unbanEmbed = new EmbedBuilder()
                .setTitle("✅ Yasak Kaldırıldı")
                .setColor("Green")
                .setDescription(`**${bannedUser.user.tag}** adlı kullanıcının yasağı başarıyla kaldırıldı.`)
                .addFields({ name: "🛡️ İşlemi Yapan", value: `${message.author}` })
                .setTimestamp();

            message.reply({ embeds: [unbanEmbed] });

        } catch (error) {
            console.error(error);
            message.reply("❌ Kullanıcı yasağı kaldırılırken bir hata oluştu. ID'nin doğruluğundan ve yetkilerimden emin olun.");
        }
    }

    // [KICK] - 1411088827589595266
    if (cmd === "kick") {
        if (!member.roles.cache.has("1411088827589595266") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const reason = args.slice(1).join(" ") || "Sebep Yok";
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");

        await target.kick(reason);
        const newScore = addIhlal(target.id, "KICK", message.author.tag, reason, CEZA_PUANLARI.KICK);
        message.reply(`👞 **${target.user.tag}** atıldı. Puan: +${CEZA_PUANLARI.KICK} (Toplam: ${newScore})`);
        // KICK komutunun sonuna ekle:
        addStaffStat(message.author.id, "kick");
        sendLog("KICK", target.user, message.author, reason, null, CEZA_PUANLARI.KICK);
    }

    // [MUTE & UNMUTE] - 1411088827581337740
    if (cmd === "mute") {
        if (!member.roles.cache.has("1411088827581337740") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const timeInput = args[1];
        const reason = args.slice(2).join(" ") || "Sebep Yok";

        if (!target || !timeInput) return message.reply("❌ Kullanım: `.mute @kullanıcı 10m Küfür`");
        const duration = parseDuration(timeInput);
        await target.timeout(duration, reason);
        const newScore = addIhlal(target.id, "MUTE", message.author.tag, reason, CEZA_PUANLARI.MUTE);
        message.reply(`🤐 **${target.user.tag}** susturuldu (${timeInput}). Puan: +${CEZA_PUANLARI.MUTE} (Toplam: ${newScore})`);
        await checkAutoJail(message, target, newScore);
        // MUTE komutunun sonuna ekle:
        addStaffStat(message.author.id, "mute");
        sendLog("MUTE", target.user, message.author, reason, timeInput, CEZA_PUANLARI.MUTE);
    }

    if (cmd === "unmute") {
        if (!member.roles.cache.has("1411088827581337740") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");
        await target.timeout(null);
        message.reply(`✅ **${target.user.tag}** susturması kaldırıldı.`);
    }

    // [VMUTE] - 1411088827581337734
    if (cmd === "vmute") {
        if (!member.roles.cache.has("1411088827581337734") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const timeInput = args[1];
        const reason = args.slice(2).join(" ") || "Sebep Yok";

        if (!target || !timeInput) return message.reply("❌ Kullanım: `.vmute @kullanıcı 5m Ses`");
        const duration = parseDuration(timeInput);
        if (target.voice.channel) { await target.voice.setMute(true).catch(() => {}); }
        else { message.channel.send("⚠️ Kullanıcı seste değil, susturulamadı ancak puanı işlendi."); }

        let avmutes = loadData('activeVmutes.json');
        const key = `${message.guild.id}_${target.id}`;
        avmutes[key] = { guildId: message.guild.id, userId: target.id, endTime: Date.now() + duration, reason };
        saveData('activeVmutes.json', avmutes);

        const newScore = addIhlal(target.id, "VMUTE", message.author.tag, reason, CEZA_PUANLARI.VMUTE);
        message.reply(`🔇 **${target.user.tag}** ses cezası aldı (${timeInput}). Puan: +${CEZA_PUANLARI.VMUTE} (Toplam: ${newScore})`);

        setTimeout(async () => {
            let currentAVM = loadData('activeVmutes.json');
            if (currentAVM[key]) {
                try { await target.voice.setMute(false); } catch {}
                delete currentAVM[key];
                saveData('activeVmutes.json', currentAVM);
            }
        }, duration);
        await checkAutoJail(message, target, newScore);
        // VMUTE komutunun sonuna ekle:
        addStaffStat(message.author.id, "vmute");
        sendLog("VMUTE", target.user, message.author, reason, timeInput, CEZA_PUANLARI.VMUTE);
    }

    // ----------------------------------------------------------------
      // SES SUSTURMA KALDIRMA (VUNMUTE)
      // ----------------------------------------------------------------
      if (cmd === "vunmute") {
          // Yetki Kontrolü
          if (!member.roles.cache.has("1411088827581337734") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");

          const targetMember = await getMember(message.guild, args[0]);
          if (!targetMember) return message.reply("❌ Lütfen susturması kaldırılacak bir kullanıcıyı etiketle veya ID gir.");

          const key = `${message.guild.id}_${targetMember.id}`;

          // 1. Kullanıcının seste susturmasını kaldır
          try {
              if (targetMember.voice.channel) {
                  await targetMember.voice.setMute(false);
              }
          } catch (err) {
              console.error("Vunmute hatası:", err);
              return message.reply("❌ Kullanıcının ses susturması kaldırılamadı (Botun yetkisi yetersiz olabilir).");
          }

          // 2. Aktif mute listesinden (RAM ve Dosya) temizle
          if (activeVmutes[key]) {
              delete activeVmutes[key];
              saveData('activeVmutes.json', activeVmutes); // Kalıcı veriden de siliyoruz
          }

          // 3. Bilgilendirme
          const embed = new EmbedBuilder()
              .setColor("Green")
              .setDescription(`✅ ${targetMember} kullanıcısının **ses susturması** ${message.author} tarafından kaldırıldı.`)
              .setTimestamp();

          message.reply({ embeds: [embed] });

          // 4. Log Kanalına Bildir
          const logChId = vmuteLogs[message.guild.id];
          const logCh = message.guild.channels.cache.get(logChId);
          if (logCh) {
              logCh.send({ 
                  embeds: [
                      new EmbedBuilder()
                          .setTitle("🔊 Ses Susturma Kaldırıldı")
                          .setColor("Green")
                          .addFields(
                              { name: "Kullanıcı", value: `${targetMember} (\`${targetMember.id}\`)`, inline: true },
                              { name: "Yetkili", value: `${message.author}`, inline: true }
                          )
                          .setTimestamp()
                  ] 
              });
          }
      }

    // [JAIL & UNJAIL] - 1411088827581337742
    if (cmd === "jail") {
        if (!member.roles.cache.has("1411088827581337742") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const timeInput = args[1];
        const reason = args.slice(2).join(" ") || "Sebep Belirtilmedi";
        if (!target || !timeInput) return message.reply("❌ Kullanım: `.jail @kullanıcı 1h Küfür`");
        const duration = parseDuration(timeInput);

        const savedRoles = target.roles.cache.filter(r => r.id !== message.guild.id && r.id !== ROLES.JAIL_ROL).map(r => r.id);
        await target.roles.set([ROLES.JAIL_ROL]);
        const key = `${message.guild.id}_${target.id}`;
        activeJails = loadData('activeJails.json');
        activeJails[key] = { savedRoles, endTime: Date.now() + duration };
        saveData('activeJails.json', activeJails);

        const newScore = addIhlal(target.id, "JAIL", message.author.tag, reason, CEZA_PUANLARI.JAIL);
        message.reply(`🚨 **${target.user.tag}** jaillendi (${timeInput}). Puan: +${CEZA_PUANLARI.JAIL} (Toplam: ${newScore})`);

        setTimeout(async () => {
            let cJails = loadData('activeJails.json');
            if (cJails[key]) {
                try { await target.roles.set(cJails[key].savedRoles); } catch {}
                delete cJails[key];
                saveData('activeJails.json', cJails);
                // JAIL komutunun sonuna ekle:
                addStaffStat(message.author.id, "jail");
                sendLog("JAIL", target.user, message.author, reason, timeInput, CEZA_PUANLARI.JAIL);
            }
        }, duration);
    }

    if (cmd === "unjail") {
        if (!member.roles.cache.has("1411088827581337742") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");
        const key = `${message.guild.id}_${target.id}`;
        activeJails = loadData('activeJails.json');
        if (activeJails[key]) {
            try { await target.roles.set(activeJails[key].savedRoles); } catch {}
            delete activeJails[key];
            saveData('activeJails.json', activeJails);
            message.reply("✅ Jail kaldırıldı.");
        } else { message.reply("⚠️ Kullanıcı sistemde jailde görünmüyor."); }
    }

    // [PUAN SIL] - 1411088827589595258
    if (cmd === "puansil" || cmd === "puan-sil") {
        if (!member.roles.cache.has("1411088827589595258") && !isYonetici && !isSahip) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        const miktar = parseInt(args[1]);
        if (!target || isNaN(miktar)) return message.reply("❌ Kullanım: `.puansil @üye 15` ");

        let db = loadData('ihlal_takip.json');
        db[target.id].toplamPuan = Math.max(0, (db[target.id].toplamPuan || 0) - miktar);
        saveData('ihlal_takip.json', db);
        // [PUAN SIL] komutunun sonuna (saveData'dan sonra) ekle:
        const logChannelId = "1434659021519847434";
        const logChannel = client.channels.cache.get(logChannelId);
        if (logChannel) {
            const pSilEmbed = new EmbedBuilder()
                .setTitle("📉 Ceza Puanı Düşürüldü")
                .setColor("Blue")
                .addFields(
                    { name: "👤 Kullanıcı", value: `${target} (\`${target.id}\`)`, inline: true },
                    { name: "👮 Yetkili", value: `${message.author}`, inline: true },
                    { name: "📉 Silinen Miktar", value: `\`${miktar}\` Puan`, inline: true },
                    { name: "📊 Yeni Puan", value: `**${db[target.id].toplamPuan}**`, inline: true }
                )
                .setTimestamp();
            logChannel.send({ embeds: [pSilEmbed] });
        }
        message.reply(`✅ **${target.user.tag}** puanı eksiltildi. Yeni Puan: **${db[target.id].toplamPuan}**`);
    }

    // [SICIL TEMIZLE]
    if (cmd === "siciltemizle") {
        if (!isYonetici && message.author.id !== OZEL_SAHIP_ID) return message.reply("❌ Yetkin yok.");
        const target = await getMember(message.guild, args[0]);
        if (!target) return message.reply("❌ Kullanıcı bulunamadı.");

        let db = loadData('ihlal_takip.json');
        if (db[target.id]) {
            delete db[target.id];
            saveData('ihlal_takip.json', db);
            // [SICIL TEMIZLE] komutunun sonuna (saveData'dan sonra) ekle:
            const logChannelId = "1434659021519847434";
            const logChannel = client.channels.cache.get(logChannelId);
            if (logChannel) {
                const sTemizleEmbed = new EmbedBuilder()
                    .setTitle("✨ Sicil Sıfırlandı")
                    .setColor("White")
                    .setDescription(`**${target.user.tag}** adlı kullanıcının tüm ihlal geçmişi ve puanları temizlendi.`)
                    .addFields(
                        { name: "👤 Kullanıcı", value: `${target} (\`${target.id}\`)`, inline: true },
                        { name: "👑 Yetkili", value: `${message.author}`, inline: true }
                    )
                    .setTimestamp();
                logChannel.send({ embeds: [sTemizleEmbed] });
            }
            message.reply(`✅ **${target.user.tag}** sicili sıfırlandı.`);
        } else {
            message.reply("⚠️ Sicil zaten temiz.");
        }
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
        if (!target) return message.reply("❌ Kimi alıyorsun?");
        if (evliUsers.has(message.author.id) || evliUsers.has(target.id)) return message.reply("❌ Kullanıcı Zaten Evli");
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("evet").setLabel("Evet").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("hayır").setLabel("Hayır").setStyle(ButtonStyle.Danger)
        );
        const msg = await message.channel.send({ content: `${target}, ${message.author} sana evlenme teklif ediyor!`, components: [row] });
        const filter = i => i.user.id === target.id;
        const collector = msg.createMessageComponentCollector({ filter, time: 60000 });
        collector.on("collect", async i => {
            if (i.customId === "evet") {
                const date = Math.floor(Date.now() / 1000);
                evliUsers.set(message.author.id, { partnerId: target.id, date });
                evliUsers.set(target.id, { partnerId: message.author.id, date });
                saveData('evliUsers.json', Object.fromEntries(evliUsers));
                await i.update({ content: `🎉 Tebrikler! ${message.author} ve ${target} evlendi!`, components: [] });
                target.roles.add(ROLES.MARRIAGE).catch(()=>{});
                message.member.roles.add(ROLES.MARRIAGE).catch(()=>{});
            } else { await i.update({ content: "❌ Reddedildi.", components: [] }); }
        });
    }

    // [BOŞAN]
    if (cmd === "boşan") {
        const data = evliUsers.get(message.author.id);
        if (!data) return message.reply("❌ Zaten bekarsın.");
        evliUsers.delete(message.author.id);
        evliUsers.delete(data.partnerId);
        saveData('evliUsers.json', Object.fromEntries(evliUsers));
        message.reply(`💔 Boşandınız.`);
        message.member.roles.remove(ROLES.MARRIAGE).catch(()=>{});
    }

    // [EVLİLİK / SHIP] - Kiminle, ne kadar süredir evli?
    if (cmd === "evlilik" || cmd === "ship") {
        const target = message.mentions.members.first() || message.member;
        const data = evliUsers.get(target.id);

        if (!data) {
            return message.reply(target.id === message.author.id 
                ? "❌ Henüz kimseyle evli değilsin. `.evlen @üye` ile ilk adımı atabilirsin!" 
                : `❌ **${target.user.tag}** şu an bekar.`);
        }

        const partner = await message.guild.members.fetch(data.partnerId).catch(() => null);
        const evlilikTarihi = data.date; // Saniye cinsinden timestamp
        const simdi = Math.floor(Date.now() / 1000);
        const fark = simdi - evlilikTarihi;

        // Süre hesaplama (Gün, Saat, Dakika)
        const gun = Math.floor(fark / 86400);
        const saat = Math.floor((fark % 86400) / 3600);
        const dakika = Math.floor((fark % 3600) / 60);

        let sureMetni = "";
        if (gun > 0) sureMetni += `**${gun}** gün, `;
        if (saat > 0) sureMetni += `**${saat}** saat, `;
        sureMetni += `**${dakika}** dakikadır evliler.`;

        const shipEmbed = new EmbedBuilder()
            .setTitle("💍 Evlilik Cüzdanı")
            .setColor("LuminousVividPink")
            .setThumbnail("https://cdn-icons-png.flaticon.com/512/3655/3655813.png") // Yüzük ikonu
            .setDescription(`${target} ❤️ ${partner ? partner : "Bilinmeyen Kullanıcı"}`)
            .addFields(
                { name: "📅 Evlilik Tarihi", value: `<t:${evlilikTarihi}:D> (<t:${evlilikTarihi}:R>)`, inline: false },
                { name: "⏳ Geçen Süre", value: sureMetni, inline: false }
            )
            .setFooter({ text: "Bir ömür boyu mutluluklar dileriz!" })
            .setTimestamp();

        message.channel.send({ embeds: [shipEmbed] });
    }

    // [YETKILI STAT]
    if (cmd === "yetkilistat" || cmd === "ystat") {
        const targetStaff = await getMember(message.guild, args[0]) || message.member;
        const stats = loadData('staff_stats.json');
        const s = stats[targetStaff.id];

        if (!s) return message.reply("⚠️ Bu yetkilinin henüz bir işlem kaydı bulunmuyor.");

        const embed = new EmbedBuilder()
            .setTitle(`📊 Yetkili İstatistikleri: ${targetStaff.user.username}`)
            .setColor("Blue")
            .setThumbnail(targetStaff.user.displayAvatarURL())
            .setDescription(`${targetStaff} adlı yetkilinin sunucu içerisindeki ceza uygulama verileri aşağıdadır:`)
            .addFields(
                { name: "🔨 Ban", value: `\`${s.ban}\` adet`, inline: true },
                { name: "👞 Kick", value: `\`${s.kick}\` adet`, inline: true },
                { name: "🤐 Mute", value: `\`${s.mute}\` adet`, inline: true },
                { name: "🔇 VMute", value: `\`${s.vmute}\` adet`, inline: true },
                { name: "🚨 Jail", value: `\`${s.jail}\` adet`, inline: true },
                { name: "📈 Toplam İşlem", value: `**${s.total}**`, inline: false }
            )
            .setFooter({ text: "İstatistikler anlık olarak güncellenmektedir." })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    if (cmd === "topstat") {
        const stats = loadData('staff_stats.json');
        const sorted = Object.entries(stats)
            .sort(([, a], [, b]) => b.total - a.total)
            .slice(0, 10);

        if (sorted.length === 0) return message.reply("Veri bulunamadı.");

        let desc = "";
        sorted.forEach(([id, data], index) => {
            desc += `**${index + 1}.** <@${id}> | Toplam: \`${data.total}\` işlem\n`;
        });

        const embed = new EmbedBuilder()
            .setTitle("🏆 En Aktif Yetkililer (Top 10)")
            .setColor("Gold")
            .setDescription(desc)
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
                    "`.yardım` - Bu menüyü açar.\n" +
                    "`.snipe` - Son silinen mesajı gösterir (nitro booster).",
                    inline: false 
                }
            );

        // Eğer mesajı yazan yetkili ise bu alanı ekle
        if (isUserYetkili || isUserYonetici) {
            helpEmb.addFields({ 
                name: "🛡️ Yetkili Komutları", 
                value: 
                "`.sicil [@üye]` - Kendi veya başkasının sicilini/puanını görür.\n" +
                "`.mute @üye [süre] [sebep]` - Chat susturma (5 Puan).\n" +
                "`.vmute @üye [süre] [sebep]` - Ses susturma (8 Puan).\n" +
                "`.jail @üye [süre] [sebep]` - Karantinaya Alma (15 Puan).\n" +
                "`.ban @üye [sebep]` - Yasaklama (40 Puan).\n" +
                "`.unban @üye [sebep]` - Yasak Kaldırma\n" +
                "`.kick @üye [sebep]` - Sunucudan Atma (20 Puan).\n" +
                "`.puansil @üye [miktar]` - Kullanıcının ceza puanını düşürür.\n" +
                "`.sil [miktar]` - Belirtilen sayıda mesajı temizler.\n" +
                "`.unmute @üye` - Chat susturmasını kaldırır.\n" +
                "`.unjail @üye` - Karantinayı kaldırır.\n" +
                "`.snipe` - Son silinen mesajı gösterir.",
                inline: false 
            });
        }

        // Eğer mesajı yazan yönetici ise bu alanı ekle
        if (isUserYonetici || message.author.id === OZEL_SAHIP_ID) {
            helpEmb.addFields({ 
                name: "⚙️ Yönetici Komutları", 
                value: 
                "`.siciltemizle @üye` - Tüm sicili ve puanı sıfırlar.\n" +
                "`.katıl` - Botu bulunduğunuz ses kanalına çeker.",
                inline: false 
            });
        }

        helpEmb.addFields({ 
            name: "📊 Puan Tablosu", 
            value: `💬 Mute: \`+${CEZA_PUAN_MUTE = 5}\` | 🎙️ VMute: \`+${CEZA_PUAN_VMUTE = 8}\` | ⚖️ Jail: \`+${CEZA_PUAN_JAIL = 15}\` | 👞 Kick: \`+${CEZA_PUAN_KICK = 20}\` | 🚫 Ban: \`+${CEZA_PUAN_BAN = 40}\``,
            inline: false 
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
// 5. ETKİLEŞİM YÖNETİMİ
// ==========================================
client.on("interactionCreate", async interaction => {
    if (interaction.isButton()) {
        const parts = interaction.customId.split("_");
        // btn_kapat kontrolü
        if (interaction.customId === "btn_kapat") return interaction.message.delete().catch(()=>{});

        if (parts[0] !== "btn" || parts[1] !== "not") return;
        const operasyon = parts[2];
        const targetId = parts[3];

        const ozelYetkili = interaction.user.id === NOT_YETKILISI_ID || interaction.member.roles.cache.has(NOT_YETKILISI_ID) || interaction.user.id === OZEL_SAHIP_ID || interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        if (!ozelYetkili) return interaction.reply({ content: "❌ Sadece sicil yetkilileri.", flags: MessageFlags.Ephemeral });

        if (operasyon === "ekle") {
            const modal = new ModalBuilder().setCustomId(`modal_not_kayit_${targetId}`).setTitle("Kullanıcıya Not Ekle");
            const notInput = new TextInputBuilder().setCustomId("not_icerik").setLabel("Notunuzu yazın").setStyle(TextInputStyle.Paragraph).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(notInput));
            await interaction.showModal(modal);
        }
        if (operasyon === "oku") {
            let notesDb = loadData('user_notes.json'); // Anlık Oku
            const notlar = notesDb[targetId] || [];
            let notMetni = notlar.length > 0 ? notlar.map((n, i) => `**${i+1}.** \`${n.tarih}\` (<@${n.yazar}>): ${n.icerik}`).join("\n\n") : "📜 Not yok.";
            if (notMetni.length > 4000) notMetni = notMetni.substring(0, 4000) + "...";
            const notEmbed = new EmbedBuilder().setTitle(`📂 <@${targetId}> - Notlar`).setColor("Blurple").setDescription(notMetni);
            await interaction.reply({ embeds: [notEmbed], flags: MessageFlags.Ephemeral });
        }
        if (operasyon === "sil") {
            let notesDb = loadData('user_notes.json'); // Anlık Oku
            const notlar = notesDb[targetId] || [];
            if (notlar.length === 0) return interaction.reply({ content: "Silinecek not yok.", flags: MessageFlags.Ephemeral });
            const selectMenu = new StringSelectMenuBuilder().setCustomId(`select_not_sil_${targetId}`).setPlaceholder('Silinecek notu seçin...').addOptions(
                notlar.map((n, index) => new StringSelectMenuOptionBuilder().setLabel(`${index + 1}. Not (${n.tarih})`).setDescription(n.icerik.substring(0, 50) + "...").setValue(index.toString()))
            );
            await interaction.reply({ content: "🗑️ Silinecek notu seçin:", components: [new ActionRowBuilder().addComponents(selectMenu)], flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_not_kayit")) {
        const targetId = interaction.customId.split("_")[3];
        const icerik = interaction.fields.getTextInputValue("not_icerik");

        let notesDb = loadData('user_notes.json'); // Anlık Oku
        if (!notesDb[targetId]) notesDb[targetId] = [];
        notesDb[targetId].push({ yazar: interaction.user.id, icerik: icerik, tarih: new Date().toLocaleDateString("tr-TR") });
        saveData('user_notes.json', notesDb);

        await interaction.reply({ content: `✅ **Not sicile eklendi!**`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("select_not_sil_")) {
        const targetId = interaction.customId.split("_")[3];
        const secilenIndex = parseInt(interaction.values[0]);

        let notesDb = loadData('user_notes.json'); // Anlık Oku ve Sil
        if (notesDb[targetId] && notesDb[targetId][secilenIndex]) {
            notesDb[targetId].splice(secilenIndex, 1);
            saveData('user_notes.json', notesDb);
            await interaction.update({ content: `✅ **Not başarıyla silindi!**`, components: [], embeds: [] });
        } else { await interaction.update({ content: "❌ Hata oluştu veya not bulunamadı.", components: [] }); }
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

