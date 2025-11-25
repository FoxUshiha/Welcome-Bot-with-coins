// index.js (single-file ESM) - Discord join reward bot (Coin Card API)
// Node 18+ required. Use .env with DISCORD_TOKEN and optional COIN_API_BASE
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  REST,
  Routes,
  Collection,
  SlashCommandBuilder
} from 'discord.js';

// ---------- Config ----------
const TOKEN = process.env.DISCORD_TOKEN;
const API_BASE = (process.env.COIN_API_BASE || 'http://coin.foxsrv.net:26450').replace(/\/+$/, '');
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in env. Set DISCORD_TOKEN in your .env and restart.');
  process.exit(1);
}

// ---------- __dirname for ESM ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- DB path ----------
const DB_PATH = path.join(__dirname, 'database.db');

// ---------- Safety ----------
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection', err);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

client.commands = new Collection();
const commands = [];

// ----------------- INLINE COMMANDS -----------------
// All commands defined here (so no commands/ folder required)

// /worth - get or set worth (8 decimals)
const worthCmd = {
  data: new SlashCommandBuilder()
    .setName('worth')
    .setDescription('Get or set the server reward worth in coins (8 decimals).')
    .addStringOption(opt => opt.setName('amount').setDescription('Amount in coins (8 decimals), or leave empty to view current')),
  async execute({ interaction, db }) {
    const amountStr = interaction.options.getString('amount');
    if (!amountStr) {
      const row = await db.get('SELECT worth FROM guilds WHERE guild_id = ?', interaction.guildId);
      const cur = row && typeof row.worth === 'number' ? row.worth.toFixed(8) : '0.00000001';
      return interaction.reply({ content: `Current worth: ${cur}`, ephemeral: true });
    }
    const parsed = parseFloat(amountStr);
    if (isNaN(parsed) || parsed <= 0) return interaction.reply({ content: 'Invalid amount.', ephemeral: true });
    const truncated = Math.floor(parsed * 1e8) / 1e8;
    await db.run('INSERT INTO guilds (guild_id, worth) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET worth=excluded.worth', interaction.guildId, truncated);
    return interaction.reply({ content: `Worth set to ${truncated.toFixed(8)}`, ephemeral: true });
  }
};

// /cardid - set card id
const cardidCmd = {
  data: new SlashCommandBuilder()
    .setName('cardid')
    .setDescription('Set the Card ID used by this server to pay join rewards.')
    .addStringOption(opt => opt.setName('card').setDescription('Card code').setRequired(true)),
  async execute({ interaction, db }) {
    const card = interaction.options.getString('card');
    if (!card) return interaction.reply({ content: 'CardID required.', ephemeral: true });
    await db.run('INSERT INTO guilds (guild_id, card_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET card_id=excluded.card_id', interaction.guildId, card);
    return interaction.reply({ content: 'CardID saved for this server.', ephemeral: true });
  }
};

// /welcome - set channel
const welcomeCmd = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Set the channel where welcome embeds will be sent.')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel for welcome messages').setRequired(true)),
  async execute({ interaction, db }) {
    const ch = interaction.options.getChannel('channel');
    if (!ch) return interaction.reply({ content: 'Invalid channel.', ephemeral: true });
    await db.run('INSERT INTO guilds (guild_id, welcome_channel) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET welcome_channel=excluded.welcome_channel', interaction.guildId, ch.id);
    return interaction.reply({ content: `Welcome channel set to ${ch}`, ephemeral: true });
  }
};

// /message - opens modal for welcome message settings
const messageCmd = {
  data: new SlashCommandBuilder()
    .setName('message')
    .setDescription('Open modal to configure the welcome message (title, message, link, button word).'),
  async execute({ interaction }) {
    const modal = new ModalBuilder().setCustomId('welcome_settings_modal').setTitle('✨ Welcome Settings ✨');

    const messageInput = new TextInputBuilder().setCustomId('welcome_message').setLabel('Message').setStyle(TextInputStyle.Paragraph).setMaxLength(512).setPlaceholder('Welcome message shown after the title');
    const titleInput   = new TextInputBuilder().setCustomId('welcome_title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(50).setPlaceholder('Title shown in the embed');
    const linkInput    = new TextInputBuilder().setCustomId('welcome_link').setLabel('Link').setStyle(TextInputStyle.Short).setPlaceholder('https://example.com');
    const wordInput    = new TextInputBuilder().setCustomId('welcome_word').setLabel('Word').setStyle(TextInputStyle.Short).setPlaceholder('Visit Site');

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(messageInput),
      new ActionRowBuilder().addComponents(linkInput),
      new ActionRowBuilder().addComponents(wordInput)
    );

    await interaction.showModal(modal);
  }
};

// register inline commands to client.commands and commands (for registration)
const inlineCommands = [worthCmd, cardidCmd, welcomeCmd, messageCmd];
for (const c of inlineCommands) {
  client.commands.set(c.data.name, c);
  commands.push(typeof c.data.toJSON === 'function' ? c.data.toJSON() : c.data);
}

// ---------- REST ----------
const rest = new REST({ version: '10' }).setToken(TOKEN);

// ---------- Database ----------
let db;
async function initDb() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      card_id TEXT,
      welcome_channel TEXT,
      welcome_title TEXT,
      welcome_message TEXT,
      welcome_link TEXT,
      welcome_word TEXT,
      worth REAL
    );
    CREATE TABLE IF NOT EXISTS joined (
      guild_id TEXT,
      user_id TEXT,
      ts INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  return db;
}

// ---------- Register commands helper ----------
async function registerCommands() {
  try {
    if (commands.length === 0) {
      console.log('No commands to register.');
      return;
    }
    console.log('Registering global commands...');
    // fetch app id safely
    const app = await client.application.fetch();
    await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log('Global commands registered');

    // register per guild for cached guilds (best-effort)
    for (const [guildId] of client.guilds.cache) {
      try {
        await rest.put(Routes.applicationGuildCommands(app.id, guildId), { body: commands });
        console.log('Registered commands for guild', guildId);
      } catch (e) {
        console.warn('Failed to register guild commands', guildId, e.message);
      }
    }
  } catch (e) {
    console.error('Failed to register commands', e);
  }
}

// ---------- Admin check ----------
function isAdmin(member) {
  try {
    if (!member) return false;
    return member.permissions.has(PermissionsBitField.Flags.Administrator);
  } catch {
    return false;
  }
}

// ---------- native fetch ----------
const fetchNative = globalThis.fetch.bind(globalThis);

// ---------- Welcome sender ----------
async function sendWelcome(guild, user) {
  try {
    const g = await db.get('SELECT * FROM guilds WHERE guild_id = ?', guild.id);
    if (!g || !g.welcome_channel) return;

    const ch = guild.channels.cache.get(g.welcome_channel) || await guild.channels.fetch(g.welcome_channel).catch(()=>null);
    if (!ch) return;

    const exists = await db.get('SELECT 1 FROM joined WHERE guild_id = ? AND user_id = ?', guild.id, user.id);
    if (exists) return; // already rewarded

    await db.run('INSERT OR REPLACE INTO joined (guild_id, user_id, ts) VALUES (?, ?, ?)', guild.id, user.id, Date.now());

    const amount = (g && typeof g.worth === 'number') ? g.worth : 0.00000001;

    if (g && g.card_id && amount > 0) {
      try {
        const payload = { cardCode: g.card_id, toId: user.id, amount };
        const resp = await fetchNative(`${API_BASE}/api/transfer/card`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json().catch(()=>({ success: false }));
        if (!data || !data.success) {
          console.warn('Card transfer returned failure or invalid response', data);
        } else {
          console.log(`Transferred ${amount} to ${user.id} via card ${g.card_id}`);
        }
      } catch (e) {
        console.error('Transfer error', e);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(g?.welcome_title ?? `${guild.name} - Welcome!`)
      .setDescription(g?.welcome_message ?? `Welcome to ${guild.name}!`)
      .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
      .addFields(
        { name: '\u200B', value: `👤 New Member: <@${user.id}>` },
        { name: '\u200B', value: `-# You received **${amount.toFixed(8)}** coins for joining. Congrats!` },
        { name: '\u200B', value: `-# ${guild.name} - **${guild.memberCount}** members - ${new Date().toLocaleString()}` }
      );

    const btnWord = g?.welcome_word ?? 'Visit Site';
    const btnLink = g?.welcome_link ?? 'https://example.com';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(btnWord).setStyle(ButtonStyle.Link).setURL(btnLink)
    );

    await ch.send({ embeds: [embed], components: [row] }).catch(e => console.error('Failed to send welcome message', e));
  } catch (e) {
    console.error('sendWelcome error', e);
  }
}

// ---------- Events ----------
client.once('ready', async () => {
  try {
    await initDb();
    console.log(`Logged in as ${client.user.tag}`);

    await registerCommands();

    // cleanup every 10 minutes: remove joined records older than 30 days
    setInterval(async () => {
      try {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const res = await db.run('DELETE FROM joined WHERE ts < ?', cutoff);
        if (res && typeof res.changes === 'number' && res.changes > 0) {
          console.log(`Cleanup removed ${res.changes} old join records.`);
        }
      } catch (e) {
        console.error('Cleanup error', e);
      }
    }, 10 * 60 * 1000);
  } catch (err) {
    console.error('Ready error', err);
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    await sendWelcome(member.guild, member.user);
  } catch (e) {
    console.error('guildMemberAdd handler error', e);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;

      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You must be an administrator to use this.', ephemeral: true });
      }

      await cmd.execute({ interaction, db, API_BASE });
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'welcome_settings_modal') {
        const msg = interaction.fields.getTextInputValue('welcome_message');
        const title = interaction.fields.getTextInputValue('welcome_title');
        const link = interaction.fields.getTextInputValue('welcome_link');
        const word = interaction.fields.getTextInputValue('welcome_word');
        try {
          await db.run(
            `INSERT INTO guilds (guild_id, welcome_message, welcome_title, welcome_link, welcome_word)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(guild_id) DO UPDATE SET
               welcome_message=excluded.welcome_message,
               welcome_title=excluded.welcome_title,
               welcome_link=excluded.welcome_link,
               welcome_word=excluded.welcome_word`,
            interaction.guildId, msg, title, link, word
          );
          await interaction.reply({ content: 'Welcome message updated.', ephemeral: true });
        } catch (e) {
          console.error('Modal save error', e);
          await interaction.reply({ content: 'Failed to save settings.', ephemeral: true });
        }
      }
    }
  } catch (err) {
    console.error('interactionCreate handler error', err);
    try { if (interaction && !interaction.replied) await interaction.reply({ content: 'Internal error.', ephemeral: true }); } catch {}
  }
});

// ---------- Login ----------
client.login('TOKEN').catch(err => {
  console.error('Failed to login — check your DISCORD_TOKEN and network connectivity', err);
});
