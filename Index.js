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

const puppeteer = require("puppeteer");
const fs = require("fs");

// ================= CONFIG =================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ================= DATA STORAGE =================

let configs = {};
if (fs.existsSync("data.json")) {
  configs = JSON.parse(fs.readFileSync("data.json"));
}

function saveData() {
  fs.writeFileSync("data.json", JSON.stringify(configs, null, 2));
}

// ================= RESET TIMERS =================

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

// ================= AUTO MAINTENANCE =================

let maintenanceWindow = null;
let lastMaintenanceCheck = 0;

async function autoDetectMaintenance() {
  try {
    if (Date.now() - lastMaintenanceCheck < 1000 * 60 * 30) return;

    lastMaintenanceCheck = Date.now();

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto(
      "https://na.finalfantasyxiv.com/lodestone/news/category/2",
      { waitUntil: "networkidle2" }
    );

    await new Promise(r => setTimeout(r, 3000));

    const maintenanceLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const match = links.find(link =>
        link.innerText.includes("All Worlds Maintenance")
      );
      return match ? match.href : null;
    });

    if (!maintenanceLink) {
      await browser.close();
      return;
    }

    await page.goto(maintenanceLink, { waitUntil: "networkidle2" });
    await new Promise(r => setTimeout(r, 3000));

    const text = await page.evaluate(() => document.body.innerText);

    await browser.close();

    const match = text.match(
      /([A-Za-z]+\.\s\d{1,2},\s\d{4}\s\d{1,2}:\d{2})\s*to\s*([A-Za-z]+\.\s\d{1,2},\s\d{4}\s\d{1,2}:\d{2})\s*\(UTC\)/i
    );

    if (!match) return;

    const start = Math.floor(new Date(match[1] + " UTC").getTime() / 1000);
    const end = Math.floor(new Date(match[2] + " UTC").getTime() / 1000);

    maintenanceWindow = { start, end };

    console.log("Maintenance auto-detected:", maintenanceWindow);

  } catch (err) {
    console.error("Maintenance detection failed:", err.message);
  }
}

// ================= EMBED UPDATE =================

async function updateAllGuilds() {
  await autoDetectMaintenance();

  const daily = getNextDailyReset();
  const weekly = getNextWeeklyReset();

  for (const guildId in configs) {
    try {
      const { channelId, messageId } = configs[guildId];
      const channel = await client.channels.fetch(channelId);

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

      const message = await channel.messages.fetch(messageId);
      await message.edit({ embeds: [embed] });

    } catch (err) {
      console.log("Failed updating guild:", guildId);
    }
  }
}

// ================= SLASH COMMANDS =================

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup FFXIV status panel")
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("Channel to post panel in")
        .setRequired(true)
    )
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log("Slash commands registered.");
  } catch (error) {
    console.error(error);
  }
})();

// ================= INTERACTION HANDLER =================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "setup") {

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "Admin only.", ephemeral: true });
    }

    const channel = interaction.options.getChannel("channel");

    const message = await channel.send({
      embeds: [new EmbedBuilder().setTitle("Initializing...")]
    });

    configs[interaction.guildId] = {
      channelId: channel.id,
      messageId: message.id
    };

    saveData();

    await interaction.reply({
      content: "Setup complete!",
      ephemeral: true
    });

    updateAllGuilds();
  }
});

// ================= READY =================

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateAllGuilds();
  setInterval(updateAllGuilds, 1000 * 60 * 5);
});

client.login(TOKEN);