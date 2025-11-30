require('dotenv').config();
const { Client, GatewayIntentBits, Events, PermissionsBitField } = require('discord.js');
const admin = require('firebase-admin');
const http = require('http');
const Parser = require('rss-parser');
const axios = require('axios');

console.log("--- BOT STARTUP DEBUG ---");
console.log("Current Directory:", process.cwd());
console.log("YOUTUBE_CHANNEL_ID loaded:", process.env.YOUTUBE_CHANNEL_ID ? "YES" : "NO");
if (process.env.YOUTUBE_CHANNEL_ID) {
    console.log("ID Length:", process.env.YOUTUBE_CHANNEL_ID.length);
}
console.log("-------------------------");

const parser = new Parser();

// Basic HTTP server to keep the bot alive on platforms like Render
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('GremlinOS Bot is Alive!');
  res.end();
}).listen(port, () => {
    console.log(`Keep-alive server listening on port ${port}`);
});

// Load Service Account (Support both Env Var for Cloud and File for Local)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var");
    }
} else {
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (e) {
        console.error("Could not find serviceAccountKey.json and FIREBASE_SERVICE_ACCOUNT is not set.");
    }
}

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID || LOG_CHANNEL_ID;

console.log("--- CHANNEL CONFIG ---");
console.log("LOG_CHANNEL_ID:", LOG_CHANNEL_ID);
console.log("NOTIFICATION_CHANNEL_ID:", NOTIFICATION_CHANNEL_ID);
console.log("----------------------");

// --- NOTIFICATION CONFIG ---
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// --- NOTIFICATION LOGIC ---

// 1. YouTube Checker (Supports API v3 & RSS)
const checkYouTube = async () => {
    if (!YOUTUBE_CHANNEL_ID) {
        console.log("⚠️ YouTube Check Skipped: No YOUTUBE_CHANNEL_ID");
        return;
    }

    // METHOD A: YouTube Data API v3 (Preferred - Faster)
    if (YOUTUBE_API_KEY) {
        try {
            // The "Uploads" playlist ID is always the Channel ID with 'UC' replaced by 'UU'
            const uploadsPlaylistId = YOUTUBE_CHANNEL_ID.replace(/^UC/, 'UU');
            
            const res = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
                params: {
                    part: 'snippet',
                    playlistId: uploadsPlaylistId,
                    maxResults: 1,
                    key: YOUTUBE_API_KEY
                }
            });

            if (!res.data.items || res.data.items.length === 0) return;

            const item = res.data.items[0];
            const videoId = item.snippet.resourceId.videoId;
            const videoTitle = item.snippet.title;

            const ref = db.ref('notifications/youtube/last_video_id');
            const snapshot = await ref.once('value');
            const lastId = snapshot.val();

            // Debug Log
            console.log(`[YouTube API] Latest: ${videoId} | Stored: ${lastId}`);

            if (lastId !== videoId) {
                console.log("🚨 New video detected (API)!");
                await ref.set(videoId);
                const channel = client.channels.cache.get(NOTIFICATION_CHANNEL_ID);
                if (channel) {
                    channel.send(`🔴 **NEW VIDEO UPLOADED!**\n**${videoTitle}**\nhttps://www.youtube.com/watch?v=${videoId}`);
                }
            }
            return; // Success, skip RSS fallback

        } catch (e) {
            console.error("❌ YouTube API Error:", e.response?.data?.error?.message || e.message);
            console.log("⚠️ Falling back to RSS...");
        }
    }

    // METHOD B: RSS Feed (Fallback - Slower)
    try {
        const feed = await parser.parseURL(`https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`);
        if (feed.items.length === 0) return;

        const latestVideo = feed.items[0];
        const videoId = latestVideo.id.split(':')[2]; // yt:video:VIDEO_ID
        
        const ref = db.ref('notifications/youtube/last_video_id');
        const snapshot = await ref.once('value');
        const lastId = snapshot.val();

        console.log(`[YouTube RSS] Latest: ${videoId} | Stored: ${lastId}`);

        if (lastId !== videoId) {
            console.log("🚨 New video detected (RSS)!");
            await ref.set(videoId);
            const channel = client.channels.cache.get(NOTIFICATION_CHANNEL_ID);
            if (channel) {
                channel.send(`🔴 **NEW VIDEO UPLOADED!**\n**${latestVideo.title}**\n${latestVideo.link}`);
            }
        }
    } catch (e) {
        console.error("❌ YouTube RSS Error:", e.message);
    }
};

client.once(Events.ClientReady, c => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
    
    // Start Notification Loops
    
    // YouTube: Check every 1 minute
    // Note: YouTube RSS feeds are cached by Google, so even if we check every second, 
    // the feed itself usually takes 5-15 minutes to update after an upload.
    setInterval(checkYouTube, 60 * 1000);

    // Initial check on startup
    checkYouTube();

    // Listen for new logins and send to Discord
    const logsRef = db.ref('login_logs');
    logsRef.limitToLast(1).on('child_added', (snapshot) => {
        const log = snapshot.val();
        // Check if the log is recent (within last 10 seconds) to avoid spamming old logs on restart
        if (Date.now() - log.timestamp < 10000) {
            const channel = client.channels.cache.get(LOG_CHANNEL_ID);
            if (channel) {
                channel.send(`🚨 **New Login Detected**\nUser: ${log.email}\nIP: ${log.ip}\nDevice: ${log.device}`);
            }
        }
    });
});

client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;

    // Helper: Check Admin
    const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);

    // Command: !ban <ip> <duration> [scare]
    if (message.content.startsWith('!ban')) {
        if (!isAdmin) return message.reply('⛔ **ACCESS DENIED**\nSuper Admin privileges required.');
        
        const args = message.content.split(' ');
        const target = args[1];
        const duration = args[2] || '1h';
        const scare = args[3] ? ['y', 'yes', 'true'].includes(args[3].toLowerCase()) : false;

        if (!target) {
            return message.reply('Usage: !ban <ip_or_device> <duration> [y/n]');
        }

        const parseDuration = (str) => {
             if (!str) return -1;
             const match = str.match(/^(\d+)(y|mo|w|d|h|m|s)$/);
             if (!match) return null;
             const val = parseInt(match[1]);
             const unit = match[2];
             const now = Date.now();
             switch(unit) {
                case 's': return now + val * 1000;
                case 'm': return now + val * 60 * 1000;
                case 'h': return now + val * 60 * 60 * 1000;
                case 'd': return now + val * 24 * 60 * 60 * 1000;
                case 'w': return now + val * 7 * 24 * 60 * 60 * 1000;
                case 'mo': return now + val * 30 * 24 * 60 * 60 * 1000;
                case 'y': return now + val * 365 * 24 * 60 * 60 * 1000;
                default: return null;
             }
        };

        const expiresAt = parseDuration(duration);
        if (expiresAt === null) {
            return message.reply('Invalid duration. Use format like 10s, 5m, 1h, 1d');
        }
        
        const banData = {
            banned_at: Date.now(),
            expires_at: expiresAt,
            banned_by: message.author.tag,
            is_scared: scare
        };

        // Determine path
        const isDevice = target.startsWith('dev_');
        const path = isDevice ? `banned_devices/${target}` : `banned_ips/${target.replace(/\./g, '_')}`;

        try {
            await db.ref(path).set(banData);
            message.reply(`✅ Banned **${target}** for ${duration} ${scare ? '(SCARED)' : ''}`);
        } catch (error) {
            message.reply(`Error: ${error.message}`);
        }
    }
    
    // Command: !unban <ip>
    if (message.content.startsWith('!unban')) {
        if (!isAdmin) return message.reply('⛔ Admin only.');
        const args = message.content.split(' ');
        const target = args[1];
        if (!target) return message.reply('Usage: !unban <ip_or_device>');
        
        const isDevice = target.startsWith('dev_');
        const path = isDevice ? `banned_devices/${target}` : `banned_ips/${target.replace(/\./g, '_')}`;
        
        try {
            await db.ref(path).remove();
            message.reply(`✅ Unbanned **${target}**`);
        } catch (error) {
            message.reply(`Error: ${error.message}`);
        }
    }

    // Command: !users (List online users)
    if (message.content.startsWith('!users')) {
        if (!isAdmin) return message.reply('⛔ Admin only.');
        try {
            const snapshot = await db.ref('online_users').once('value');
            if (!snapshot.exists()) return message.reply('No users online.');
            
            const users = snapshot.val();
            let reply = '**Online Users:**\n';
            
            Object.values(users).forEach(u => {
                reply += `🖥️ **${"REDACTED"}** (${u.location})\nID: \`${u.deviceId}\`\nISP: ${u.isp}\n\n`;
            });
            
            // Discord message limit is 2000 chars, truncate if needed
            if (reply.length > 2000) {
                reply = reply.substring(0, 1900) + '... (truncated)';
            }
            
            message.reply(reply);
        } catch (error) {
            message.reply(`Error fetching users: ${error.message}`);
        }
    }

    // Command: !join [optional_name]
    if (message.content.startsWith('!join')) {
        const args = message.content.split(' ');
        // Use provided name or fallback to Discord username
        let displayName = message.author.username;
        if (args.length > 1) {
            // Join all arguments after "!join" to allow spaces in names
            displayName = message.content.slice(6).trim();
        }

        const userRef = db.ref(`giveaway/entries/${message.author.id}`);

        try {
            // Check if already joined
            const snapshot = await userRef.once('value');
            if (snapshot.exists()) {
                return message.reply('⚠️ **You have already joined!** One entry per person.');
            }

            const entry = {
                username: displayName,
                id: message.author.id,
                avatar: message.author.displayAvatarURL(),
                joined_at: Date.now()
            };

            await userRef.set(entry);
            message.reply(`🎟️ **Entry Confirmed!** Ticket Name: **${displayName}**`);
        } catch (error) {
            message.reply(`Error joining giveaway: ${error.message}`);
        }
    }

    // Command: !clear_giveaway (Admin Only)
    if (message.content.startsWith('!clear_giveaway')) {
        if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return message.reply('⛔ Admin only.');
        }
        try {
            await db.ref('giveaway/entries').remove();
            message.reply('🗑️ **Giveaway entries cleared.**');
        } catch (error) {
            message.reply(`Error clearing entries: ${error.message}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
