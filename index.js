require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require("discord.js");

const Parser = require("rss-parser");
const rssParser = new Parser();
const fs = require("fs");
const express = require("express");

// ================== EXPRESS (START IMMEDIATELY) ==================

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("FFXIV Timer Bot is running.");
});

app.listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});

// ================== DISCORD CONFIG ==================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing TOKEN or CLIENT_ID in environment variables.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ================== DATA STORAGE ==================

let configs = {};
if (fs.existsSync("data.json")) {
  configs = JSON.parse(fs.readFileSync("data.json"));
}

function saveData() {
  fs.writeFileSync("data.json", JSON.stringify(configs, null, 2));
}

// ================== RESET CALCULATIONS ==================

function getNextDailyReset() {
  const now = new Date();
  const reset = new Date();
  reset.setUTCHours(15, 0, 0, 0);
  if (now > reset) reset.setUTCDate(reset.getUTCDate() + 1);
  return Math.floor(reset.getTime() / 1000);
}

function getNextWeeklyReset() {
  const now = new Date();
  const reset = new Date();
  const day = reset.getUTCDay();
  const daysUntilTuesday = (2 - day + 7) % 7;
  reset.setUTCDate(reset.getUTCDate() + daysUntilTuesday);
  reset.setUTCHours(8, 0, 0, 0);
  if (now > reset) reset.setUTCDate(reset.getUTCDate() + 7);
  return Math.floor(reset.getTime() / 1000);
}

// ================== RSS MAINTENANCE ==================

let maintenanceWindow = null;
let lastMaintenanceCheck = 0;

async function autoDetectMaintenance() {
  try {
    if (Date.now() - lastMaintenanceCheck < 1000 * 60 * 15) return;
    lastMaintenanceCheck = Date.now();

    const feed = await rssParser.parseURL(
      "https://na.finalfantasyxiv.com/lodestone/news/news.xml"
    );

    const item = feed.items.find(entry =>
      entry.title.toLowerCase().includes("maintenance") &&
      entry.title.toLowerCase().includes("world")
    );

    if (!item) {
      maintenanceWindow = null;
      return;
    }

    const desc =
      item.content ||
      item["content:encoded"] ||
      item.contentSnippet ||
      item.description;

    if (!desc) return;

    const match = desc.match(
      /([A-Za-z]+\.*\s?\d{1,2},\s\d{4}\s\d{1,2}:\d{2})\s*\(UTC\)[\s\S]*?([A-Za-z]+\.*\s?\d{1,2},\s\d{4}\s\d{1,2}:\d{2})\s*\(UTC\)/i
    );

    if (!match) return;

    const start = Math.floor(new Date(match[1] + " UTC").getTime() / 1000);
    const end = Math.floor(new Date(match[2] + " UTC").getTime() / 1000);

    maintenanceWindow = { start, end };

    console.log("Maintenance detected:", maintenanceWindow);

  } catch (err) {
    console.error("RSS error:", err.message);
  }
}

// ================== EMBED UPDATE ==================

async function updateAllGuilds() {
  await autoDetectMaintenance();

  const daily = getNextDailyReset();
  const weekly = getNextWeeklyReset();

  for (const guildId in configs) {
    try {
      const { channelId, messageId } = configs[guildId];
      const channel = await client.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);

      let status = "🟢 **SERVERS ONLINE**";
      let color = 0x9b59b6;
      let maintenanceField = "No maintenance scheduled";

      if (maintenanceWindow) {
        const now = Math.floor(Date.now() / 1000);

        if (now >= maintenanceWindow.start && now <= maintenanceWindow.end) {
          status = "🔴 **MAINTENANCE ACTIVE**";
          color = 0xff4444;
        }

        maintenanceField =
`> 🟣 Starts: <t:${maintenanceWindow.start}:F>
> 🔚 Ends: <t:${maintenanceWindow.end}:F>
> ⏳ <t:${maintenanceWindow.start}:R>`;
      }

      const embed = new EmbedBuilder()
        .setTitle("✦ FFXIV Server Status ✦")
        .setColor(color)
        .addFields(
          { name: "🌐 Server Status", value: status },
          { name: "🕒 Daily Reset", value: `<t:${daily}:F>\n(<t:${daily}:R>)` },
          { name: "🗓 Weekly Reset", value: `<t:${weekly}:F>\n(<t:${weekly}:R>)` },
          { name: "🛠 All Worlds Maintenance", value: maintenanceField }
        )
        .setTimestamp();

      await message.edit({ embeds: [embed] });

    } catch {
      delete configs[guildId];
      saveData();
    }
  }
}

// ================== SLASH COMMAND ==================

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup FFXIV status panel")
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("Channel to post panel in")
        .setRequired(true)
    )
    .toJSON()
];

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "setup") {

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "Admin only.", flags: 64 });
    }

    const channel = interaction.options.getChannel("channel");

    if (!channel.isTextBased()) {
      return interaction.reply({
        content: "Please select a text channel.",
        flags: 64
      });
    }

    await interaction.deferReply({ flags: 64 });

    try {
      const message = await channel.send({
        embeds: [new EmbedBuilder().setTitle("Initializing...")]
      });

      configs[interaction.guildId] = {
        channelId: channel.id,
        messageId: message.id
      };

      saveData();

      await interaction.editReply("✅ Setup complete!");
      updateAllGuilds();

    } catch (err) {
      console.error(err);
      await interaction.editReply("❌ Failed to setup. Check permissions.");
    }
  }
});

// ================== LOGIN (NON-BLOCKING) ==================

console.log("Attempting Discord login...");

client.login(TOKEN)
  .then(() => console.log("Login promise resolved."))
  .catch(err => console.error("Login failed:", err));

// ================== READY ==================

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Slash registration error:", err);
  }

  updateAllGuilds();
  setInterval(updateAllGuilds, 1000 * 60 * 5);
});