require('dotenv').config();
const { Client, GatewayIntentBits, Events, PermissionsBitField } = require('discord.js');
const admin = require('firebase-admin');
const http = require('http');

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

client.once(Events.ClientReady, c => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
    
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
