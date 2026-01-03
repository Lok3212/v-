const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    getVoiceConnection
} = require("@discordjs/voice");

const play = require("play-dl");

async function playMusic(message, url) {
    const channel = message.member.voice.channel;
    if (!channel) return message.reply("❌ Ses kanalında değilsin.");

    if (!play.yt_validate(url))
        return message.reply("❌ Geçerli YouTube linki değil.");

    const stream = await play.stream(url);
    const resource = createAudioResource(stream.stream, {
        inputType: stream.type
    });

    const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true
    });

    connection.subscribe(player);
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        connection.destroy();
    });

    message.reply("🎶 Müzik başladı!");
}

function stopMusic(message) {
    const connection = getVoiceConnection(message.guild.id);
    if (connection) connection.destroy();
    message.reply("⏹️ Müzik durduruldu.");
}

module.exports = { playMusic, stopMusic };
