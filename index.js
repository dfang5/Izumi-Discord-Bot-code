const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ChannelType, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelSelectMenuBuilder } = require('discord.js');
const { calculateRisk } = require('./risks');
const { makeCheckEmbed } = require('./embeds');
const mongoose = require('mongoose');
require('dotenv').config();

const ServerConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  reactionLogsChannel: { type: String, default: null },
  deletedLogsChannel: { type: String, default: null },
  editLogsChannel: { type: String, default: null },
  warnDeleteTimeout: { type: Number, default: 60 },
  quarantine: {
    enabled: { type: Boolean, default: false },
    ageThreshold: { type: Number, default: 0 },
    ageEnabled: { type: Boolean, default: false },
    massJoinEnabled: { type: Boolean, default: false },
    massJoinTime: { type: Number, default: 5 },
    massJoinCount: { type: Number, default: 10 },
    profileCheckEnabled: { type: Boolean, default: false },
    linkCheckEnabled: { type: Boolean, default: false }
  }
});

const AdvancedChannelConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  mode: { type: String, default: null },
  restrictedRoles: { type: [String], default: [] },
  restrictedUsers: { type: [String], default: [] },
  exemptRoles: { type: [String], default: [] },
  exemptUsers: { type: [String], default: [] }
});
AdvancedChannelConfigSchema.index({ guildId: 1, channelId: 1 }, { unique: true });

const ServerConfigModel = mongoose.model('IzumiServerConfig', ServerConfigSchema);
const AdvancedChannelConfigModel = mongoose.model('IzumiAdvancedConfig', AdvancedChannelConfigSchema);

const ActivityLogSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  date: { type: String, required: true },
  messages: { type: Number, default: 0 },
  links: { type: Number, default: 0 },
  mentions: { type: Number, default: 0 },
  uniqueChannels: { type: [String], default: [] }
});
ActivityLogSchema.index({ guildId: 1, userId: 1, date: 1 }, { unique: true });
const ActivityLogModel = mongoose.model('IzumiActivityLog', ActivityLogSchema);

const QuarantinedUserSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  savedRoles: { type: [String], default: [] },
  quarantineChannelId: { type: String, default: null },
  reason: { type: String, default: '' },
  quarantinedBy: { type: String, default: 'Automatic' },
  quarantinedAt: { type: Date, default: Date.now }
});
QuarantinedUserSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const QuarantinedUserModel = mongoose.model('IzumiQuarantinedUser', QuarantinedUserSchema);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences
  ]
});

// Storage for server configurations (in production, use a database)
const serverConfigs = new Map();
const joinLog = new Map();
const userFirstMessage = new Map();
const advancedConfig = new Map(); // guildId -> Map<channelId, ChannelConfig>

// Slash command definitions
const commands = [
  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check if a user is potentially an alt account')
    .addUserOption(option => 
      option.setName('user')
        .setDescription('The user to check')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('configure')
    .setDescription('Configure security settings')
    .addSubcommand(subcommand =>
      subcommand
        .setName('quarantine')
        .setDescription('Configure the quarantine system')),

  new SlashCommandBuilder()
    .setName('quarantine')
    .setDescription('Manually quarantine a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to quarantine')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('allow')
    .setDescription('Allow a quarantined user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to allow')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Get information about the current server'),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Get detailed information about a user')
    .addUserOption(option => 
      option.setName('user')
        .setDescription('The user to get info about')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('althistory')
    .setDescription('View recent alt account checks in this server')
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Number of recent checks to show (1-10)')
        .setMinValue(1)
        .setMaxValue(10)),

  new SlashCommandBuilder()
    .setName('setreactionlogs')
    .setDescription('Configure reaction logging channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('setdeletedlogs')
    .setDescription('Configure deleted message logging channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('seteditlogs')
    .setDescription('Configure message edit logging channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('logstatus')
    .setDescription('View current logging configuration (Moderator only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message to a specified channel (Admin only)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to send the message to')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The message to send')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('riskreport')
    .setDescription('Generate a comprehensive server security and safety assessment')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('behavioursummary')
    .setDescription('Analyze a user\'s activity patterns and message history')
    .addUserOption(option => 
      option.setName('user')
        .setDescription('The user to analyze')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Moderation commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('messages')
        .setDescription('Delete all messages from a specific user in this channel')
        .addUserOption(option => 
          option.setName('user')
            .setDescription('The user whose messages should be deleted')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('userid')
            .setDescription('The user ID whose messages should be deleted')
            .setRequired(false)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('advanced')
    .setDescription('Advanced content restriction controls')
    .addSubcommand(subcommand =>
      subcommand
        .setName('toggle')
        .setDescription('Configure per-channel content restrictions, role jurisdiction, and user exemptions'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

// Helper functions for permissions
function isAdmin(member) {
  return member.permissions.has('Administrator') || member.permissions.has('ManageGuild');
}

function isModerator(member) {
  return member.permissions.has('ModerateMembers') || member.permissions.has('BanMembers') || member.permissions.has('KickMembers') || isAdmin(member);
}

// Helper function to get server config
function getServerConfig(guildId) {
  if (!serverConfigs.has(guildId)) {
    serverConfigs.set(guildId, {
      reactionLogsChannel: null,
      deletedLogsChannel: null,
      editLogsChannel: null,
      warnDeleteTimeout: 60,
      quarantine: {
        enabled: false,
        ageThreshold: 0,
        ageEnabled: false,
        massJoinEnabled: false,
        massJoinTime: 5,
        massJoinCount: 10,
        profileCheckEnabled: false,
        linkCheckEnabled: false
      }
    });
  }
  if (serverConfigs.get(guildId).warnDeleteTimeout === undefined) {
    serverConfigs.get(guildId).warnDeleteTimeout = 60;
  }
  return serverConfigs.get(guildId);
}

// ---- Advanced config helpers ----

function getAdvancedGuildConfig(guildId) {
  if (!advancedConfig.has(guildId)) advancedConfig.set(guildId, new Map());
  return advancedConfig.get(guildId);
}

function getAdvancedChannelConfig(guildId, channelId) {
  const guildCfg = getAdvancedGuildConfig(guildId);
  if (!guildCfg.has(channelId)) {
    guildCfg.set(channelId, {
      mode: null,
      restrictedRoles: [],
      restrictedUsers: [],
      exemptRoles: [],
      exemptUsers: []
    });
  }
  return guildCfg.get(channelId);
}

function isSubjectToAdvancedRestriction(member, cfg) {
  if (cfg.exemptUsers.includes(member.id)) return false;
  if (cfg.exemptRoles.some(roleId => member.roles.cache.has(roleId))) return false;
  if (cfg.restrictedRoles.length > 0 || cfg.restrictedUsers.length > 0) {
    return cfg.restrictedRoles.some(roleId => member.roles.cache.has(roleId)) ||
           cfg.restrictedUsers.includes(member.id);
  }
  return true;
}

async function checkAdvancedRestrictions(message) {
  const guildCfg = advancedConfig.get(message.guild.id);
  if (!guildCfg) return false;

  const channelCfg = guildCfg.get(message.channel.id);
  if (!channelCfg || !channelCfg.mode) return false;

  const member = message.member;
  if (!member || isAdmin(member)) return false;
  if (!isSubjectToAdvancedRestriction(member, channelCfg)) return false;

  const warnTimeout = getServerConfig(message.guild.id).warnDeleteTimeout;
  const scheduleDelete = (msg) => {
    if (warnTimeout !== null) {
      setTimeout(() => msg.delete().catch(() => {}), warnTimeout * 1000);
    }
  };

  if (channelCfg.mode === 'messages_only') {
    const hasMedia = message.attachments.some(a =>
      a.contentType?.startsWith('image/') || a.contentType?.startsWith('video/')
    ) || message.embeds.some(e => e.image || e.video || e.thumbnail);

    if (hasMedia) {
      const savedText = message.content?.trim() || '';
      await message.delete().catch(() => {});
      const response = await message.channel.send({
        content: `${member}, this channel is set to **text only**. Your message was removed because it contained media.\n\n` +
          (savedText
            ? `Your text has been saved. Copy and resend it:\n\`\`\`\n${savedText.substring(0, 1800)}\n\`\`\``
            : 'Your message contained no text content.')
      });
      scheduleDelete(response);
      return true;
    }
  }

  if (channelCfg.mode === 'media_only') {
    const hasText = message.content && message.content.trim().length > 0;
    const hasMedia = message.attachments.some(a =>
      a.contentType?.startsWith('image/') || a.contentType?.startsWith('video/')
    );
    if (hasText && !hasMedia) {
      await message.delete().catch(() => {});
      const response = await message.channel.send({
        content: `${member}, this channel is set to **media only**. Your message was removed because it contained no media.\n\n` +
          'Please include an image or video with your message.'
      });
      scheduleDelete(response);
      return true;
    }
  }

  return false;
}

function buildAdvancedPanel(guild, channelId) {
  const guildCfg = getAdvancedGuildConfig(guild.id);
  const channel = guild.channels.cache.get(channelId);
  const cfg = guildCfg.has(channelId) ? guildCfg.get(channelId) : { mode: null, restrictedRoles: [], exemptRoles: [], exemptUsers: [] };
  const serverCfg = getServerConfig(guild.id);
  const timeout = serverCfg.warnDeleteTimeout;
  const timeoutLabel = timeout === null ? 'Never' : timeout < 60 ? `${timeout}s` : `${timeout / 60}min`;

  const modeLabel = cfg.mode === 'messages_only' ? 'Messages Only'
    : cfg.mode === 'media_only' ? 'Media Only'
    : 'Unrestricted';

  const modeColor = cfg.mode === 'messages_only' ? 0x5865F2
    : cfg.mode === 'media_only' ? 0x9B59B6
    : 0x36393F;

  const restrictedText = cfg.restrictedRoles.length > 0
    ? cfg.restrictedRoles.map(id => `<@&${id}>`).join(', ')
    : 'All members';

  const exemptRolesText = cfg.exemptRoles.length > 0
    ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ')
    : 'None';

  const exemptUsersText = cfg.exemptUsers.length > 0
    ? cfg.exemptUsers.map(id => `<@${id}>`).join(', ')
    : 'None';

  const embed = new EmbedBuilder()
    .setTitle(`Advanced Security | #${channel?.name || channelId}`)
    .setDescription('Configure content restrictions for this channel. Mode changes apply immediately.')
    .addFields(
      { name: 'Current Mode', value: `**${modeLabel}**`, inline: true },
      { name: 'Warning Auto-Delete', value: `**${timeoutLabel}**`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Restricted To', value: restrictedText, inline: true },
      { name: 'Exempt Roles', value: exemptRolesText, inline: true },
      { name: 'Exempt Users', value: exemptUsersText, inline: true }
    )
    .setColor(modeColor)
    .setFooter({ text: 'Administrators are always exempt. Use the selects below to manage roles and users.' })
    .setTimestamp();

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`adv_chan_${guild.id}`)
    .setPlaceholder(`Viewing: #${channel?.name || channelId} — select another to switch`)
    .setChannelTypes([ChannelType.GuildText])
    .setMinValues(1)
    .setMaxValues(1);

  const modeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`adv_mode_messages_${channelId}`)
      .setLabel('Messages Only')
      .setStyle(cfg.mode === 'messages_only' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`adv_mode_media_${channelId}`)
      .setLabel('Media Only')
      .setStyle(cfg.mode === 'media_only' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`adv_mode_off_${channelId}`)
      .setLabel('Unrestricted')
      .setStyle(!cfg.mode ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`adv_timer_${channelId}`)
      .setLabel(`Warning Timer: ${timeoutLabel}`)
      .setStyle(ButtonStyle.Secondary)
  );

  const restrictRolesSelect = new RoleSelectMenuBuilder()
    .setCustomId(`adv_roles_restrict_${channelId}`)
    .setPlaceholder('Restrict to these roles — leave empty to apply to all members')
    .setMinValues(0)
    .setMaxValues(25);

  const exemptRolesSelect = new RoleSelectMenuBuilder()
    .setCustomId(`adv_roles_exempt_${channelId}`)
    .setPlaceholder('Exempt these roles from restrictions')
    .setMinValues(0)
    .setMaxValues(25);

  const exemptUsersSelect = new UserSelectMenuBuilder()
    .setCustomId(`adv_users_exempt_${channelId}`)
    .setPlaceholder('Exempt these users from restrictions')
    .setMinValues(0)
    .setMaxValues(25);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      modeRow,
      new ActionRowBuilder().addComponents(restrictRolesSelect),
      new ActionRowBuilder().addComponents(exemptRolesSelect),
      new ActionRowBuilder().addComponents(exemptUsersSelect)
    ]
  };
}

// ---- MongoDB persistence ----

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
}

async function saveServerConfig(guildId) {
  try {
    const data = serverConfigs.get(guildId);
    if (!data) return;
    await ServerConfigModel.findOneAndUpdate(
      { guildId },
      { guildId, ...data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error(`Failed to save server config for ${guildId}:`, err);
  }
}

async function saveAdvancedChannelConfig(guildId, channelId) {
  try {
    const guildCfg = advancedConfig.get(guildId);
    if (!guildCfg) return;
    const data = guildCfg.get(channelId);
    if (!data) return;
    await AdvancedChannelConfigModel.findOneAndUpdate(
      { guildId, channelId },
      { guildId, channelId, ...data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error(`Failed to save advanced config for ${guildId}/${channelId}:`, err);
  }
}

async function loadAllConfigs() {
  try {
    const serverDocs = await ServerConfigModel.find({}).lean();
    for (const doc of serverDocs) {
      serverConfigs.set(doc.guildId, {
        reactionLogsChannel: doc.reactionLogsChannel ?? null,
        deletedLogsChannel: doc.deletedLogsChannel ?? null,
        editLogsChannel: doc.editLogsChannel ?? null,
        warnDeleteTimeout: doc.warnDeleteTimeout !== undefined ? doc.warnDeleteTimeout : 60,
        quarantine: {
          enabled: doc.quarantine?.enabled ?? false,
          ageThreshold: doc.quarantine?.ageThreshold ?? 0,
          ageEnabled: doc.quarantine?.ageEnabled ?? false,
          massJoinEnabled: doc.quarantine?.massJoinEnabled ?? false,
          massJoinTime: doc.quarantine?.massJoinTime ?? 5,
          massJoinCount: doc.quarantine?.massJoinCount ?? 10,
          profileCheckEnabled: doc.quarantine?.profileCheckEnabled ?? false,
          linkCheckEnabled: doc.quarantine?.linkCheckEnabled ?? false
        }
      });
    }

    const advancedDocs = await AdvancedChannelConfigModel.find({}).lean();
    for (const doc of advancedDocs) {
      if (!advancedConfig.has(doc.guildId)) advancedConfig.set(doc.guildId, new Map());
      advancedConfig.get(doc.guildId).set(doc.channelId, {
        mode: doc.mode ?? null,
        restrictedRoles: doc.restrictedRoles ?? [],
        restrictedUsers: doc.restrictedUsers ?? [],
        exemptRoles: doc.exemptRoles ?? [],
        exemptUsers: doc.exemptUsers ?? []
      });
    }

    console.log(`Loaded ${serverDocs.length} server config(s) and ${advancedDocs.length} advanced channel config(s) from MongoDB`);
  } catch (err) {
    console.error('Failed to load configs from MongoDB:', err);
  }
}

// ---- End MongoDB persistence ----

// ---- End advanced config helpers ----

async function quarantineUser(member, reason, moderator = null) {
  const guild = member.guild;

  // Check bot permissions upfront
  const botMember = guild.members.cache.get(client.user.id);
  if (!botMember) return { success: false, error: 'Could not resolve my own member object.' };
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { success: false, error: 'I am missing the Manage Roles permission.' };
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'I am missing the Manage Channels permission.' };
  }

  // Find or create the Quarantined role (no base permissions)
  let quarantineRole = guild.roles.cache.find(r => r.name === 'Quarantined');
  if (!quarantineRole) {
    try {
      quarantineRole = await guild.roles.create({
        name: 'Quarantined',
        color: 0xFF6B6B,
        hoist: false,
        mentionable: false,
        permissions: [],
        reason: 'Izumi quarantine system setup'
      });
    } catch (e) {
      console.error('Error creating quarantine role:', e);
      return { success: false, error: 'Failed to create the Quarantined role. Check my role hierarchy.' };
    }
  }

  // Build a safe channel name from the username
  const safeName = ('quarantine-' + member.user.username.toLowerCase()
    .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 20))
    || ('quarantine-' + member.user.id);

  // Find mod roles so they can see the private quarantine channel
  const modRoleOverwrites = guild.roles.cache
    .filter(r =>
      r.id !== guild.id &&
      r.id !== quarantineRole.id &&
      (r.permissions.has(PermissionFlagsBits.ModerateMembers) ||
       r.permissions.has(PermissionFlagsBits.BanMembers) ||
       r.permissions.has(PermissionFlagsBits.ManageGuild))
    )
    .map(r => ({
      id: r.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    }));

  // The permission set for the private channel:
  // - @everyone: denied
  // - Quarantined role: denied (so other quarantined users cannot see this channel)
  // - The specific user: explicitly allowed (user-specific overrides are highest priority in Discord)
  // - Bot: allowed with management permissions
  // - Any mod roles: allowed
  const channelOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: quarantineRole.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: member.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]
    },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks]
    },
    ...modRoleOverwrites
  ];

  // Find an existing quarantine channel for this user (by stored ID or by name fallback)
  let quarantineChannel = null;
  const existingRecord = await QuarantinedUserModel.findOne({ guildId: guild.id, userId: member.id });
  if (existingRecord?.quarantineChannelId) {
    quarantineChannel = guild.channels.cache.get(existingRecord.quarantineChannelId) || null;
  }

  if (quarantineChannel) {
    // Reuse and patch the existing channel's overrides
    try {
      await quarantineChannel.permissionOverwrites.set(channelOverwrites);
    } catch (e) {
      console.warn('Could not patch existing quarantine channel overrides:', e.message);
    }
  } else {
    // Create a fresh private channel for this user
    try {
      quarantineChannel = await guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        topic: `Private quarantine channel for ${member.user.tag}.`,
        permissionOverwrites: channelOverwrites
      });
    } catch (e) {
      console.error('Error creating quarantine channel:', e);
      return { success: false, error: 'Failed to create the quarantine channel. Check my permissions.' };
    }
  }

  // Save the user's current roles and the quarantine channel ID to MongoDB
  const savedRoleIds = member.roles.cache
    .filter(r => r.id !== guild.id)
    .map(r => r.id);

  await QuarantinedUserModel.findOneAndUpdate(
    { guildId: guild.id, userId: member.id },
    {
      guildId: guild.id, userId: member.id,
      savedRoles: savedRoleIds,
      quarantineChannelId: quarantineChannel.id,
      reason: reason || '',
      quarantinedBy: moderator?.tag || 'Automatic',
      quarantinedAt: new Date()
    },
    { upsert: true, new: true }
  ).catch(e => console.error('Failed to save quarantine record:', e));

  // Strip all manageable roles from the user (double-lock alongside the channel denies)
  const roleIdsToRemove = savedRoleIds.filter(id => {
    const role = guild.roles.cache.get(id);
    return role && botMember.roles.highest.comparePositionTo(role) > 0;
  });
  if (roleIdsToRemove.length > 0) {
    await member.roles.remove(roleIdsToRemove, 'Quarantine: stripping roles').catch(
      e => console.warn('Could not strip some roles during quarantine:', e.message)
    );
  }

  // Deny ViewChannel for the Quarantined role on every channel except the user's private channel
  for (const [, channel] of guild.channels.cache) {
    if (channel.id === quarantineChannel.id) continue;
    try {
      await channel.permissionOverwrites.edit(quarantineRole.id, { ViewChannel: false });
    } catch (e) {
      console.warn(`Could not deny ViewChannel on #${channel.name}: ${e.message}`);
    }
  }

  // Assign the Quarantined role
  try {
    await member.roles.add(quarantineRole, `Quarantined: ${reason}`);
  } catch (e) {
    console.error('Error adding quarantine role:', e);
    return { success: false, error: 'Failed to assign the Quarantined role. Check my role hierarchy.' };
  }

  const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));

  // DM the user
  try {
    const dmEmbed = new EmbedBuilder()
      .setTitle('You Have Been Quarantined')
      .setDescription(`You have been placed into quarantine in **${guild.name}**.\n\nYou have access to your own private quarantine channel. Only you and the moderation team can see it.`)
      .addFields(
        { name: 'Reason', value: reason || 'No reason provided', inline: false },
        { name: 'What to do', value: 'Please wait in your quarantine channel. A moderator will review your account shortly.', inline: false }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();
    await member.send({ embeds: [dmEmbed] });
  } catch (e) { /* DMs may be closed */ }

  // Post a report inside the private quarantine channel
  const reportEmbed = new EmbedBuilder()
    .setTitle('User Quarantined')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription(`${member} — this is your private quarantine channel. Only you and the moderation team can see this. Please wait for a moderator to review your account.`)
    .addFields(
      { name: 'User', value: `${member.user.tag}\n\`${member.user.id}\``, inline: true },
      { name: 'Account Age', value: `${accountAgeDays} day${accountAgeDays !== 1 ? 's' : ''}`, inline: true },
      { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: false },
      { name: 'Actioned By', value: moderator ? `${moderator.tag}` : 'Izumi (Automatic)', inline: true },
      { name: 'Quarantined At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setColor(0xFF6B6B)
    .setFooter({ text: 'Use /allow to release this user from quarantine.' })
    .setTimestamp();

  try {
    await quarantineChannel.send({ content: `${member}`, embeds: [reportEmbed] });
  } catch (e) {
    console.error('Error sending quarantine channel message:', e);
  }

  return { success: true, quarantineChannel };
}

// Helper function to create channel selection menu
function createChannelSelectMenu(guildId, logType) {
  const guild = client.guilds.cache.get(guildId);
  const textChannels = guild.channels.cache
    .filter(channel => channel.type === ChannelType.GuildText)
    .first(25); // Discord limit

  const options = textChannels.map(channel => ({
    label: `#${channel.name}`,
    value: channel.id,
    description: `Set as ${logType} logs channel`
  }));

  if (options.length === 0) {
    options.push({
      label: 'No text channels available',
      value: 'none',
      description: 'Create a text channel first'
    });
  }

  return new StringSelectMenuBuilder()
    .setCustomId(`select_${logType}_logs_${guildId}`)
    .setPlaceholder(`Choose a channel for ${logType} logs`)
    .addOptions(options);
}

// Advanced mutual server analysis
async function analyzeMutualConnections(targetUser, requestingUser, client) {
  const mutualConnections = [];
  const suspiciousPatterns = [];

  try {
    // Get mutual guilds (limited by Discord API)
    const mutualGuilds = client.guilds.cache.filter(guild => {
      try {
        return guild.members.cache.has(targetUser.id) && guild.members.cache.has(requestingUser.id);
      } catch {
        return false;
      }
    });

    for (const [guildId, guild] of mutualGuilds) {
      try {
        const targetMember = await guild.members.fetch(targetUser.id);
        const requestingMember = await guild.members.fetch(requestingUser.id);

        // Analyze join timing patterns
        const joinTimeDiff = Math.abs(targetMember.joinedTimestamp - requestingMember.joinedTimestamp);
        const joinDiffHours = joinTimeDiff / (1000 * 60 * 60);

        const connectionData = {
          guildName: guild.name,
          guildId: guild.id,
          targetJoined: targetMember.joinedTimestamp,
          requestingUserJoined: requestingMember.joinedTimestamp,
          joinTimeDifference: joinDiffHours,
          targetRoles: targetMember.roles.cache.size - 1,
          bothHaveRoles: (targetMember.roles.cache.size > 1) && (requestingMember.roles.cache.size > 1)
        };

        mutualConnections.push(connectionData);

        // Detect suspicious patterns
        if (joinDiffHours < 24) {
          suspiciousPatterns.push(` Joined ${guild.name} within 24 hours of each other`);
        }

        if (joinDiffHours < 1) {
          suspiciousPatterns.push(` Joined ${guild.name} within 1 hour of each other`);
        }

      } catch (error) {
        // Skip if can't fetch members
      }
    }

    return {
      mutualCount: mutualConnections.length,
      connections: mutualConnections.slice(0, 5), // Limit to 5 for display
      suspiciousPatterns: suspiciousPatterns,
      hasCloseTimingPattern: suspiciousPatterns.some(p => p.includes('hour'))
    };

  } catch (error) {
    return {
      mutualCount: 0,
      connections: [],
      suspiciousPatterns: [' Unable to analyze mutual connections'],
      hasCloseTimingPattern: false
    };
  }
}

//  Bot login and slash command registration
client.once('ready', async () => {
  console.log(` Logged in as ${client.user.tag}`);

  await connectDB();
  await loadAllConfigs();

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  try {
    console.log(' Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log(' Slash commands registered successfully!');
  } catch (error) {
    console.error(' Error registering slash commands:', error);
  }
});

//  Message command handler with loading reactions
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.guild) {
    // Real-time activity tracking
    const today = new Date().toISOString().split('T')[0];
    const linkCount = (message.content.match(/(https?:\/\/[^\s]+)/g) || []).length;
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    ActivityLogModel.findOneAndUpdate(
      { guildId: message.guild.id, userId: message.author.id, date: today },
      { $inc: { messages: 1, links: linkCount, mentions: mentionCount }, $addToSet: { uniqueChannels: message.channel.id } },
      { upsert: true }
    ).catch(err => console.error('Activity log error:', err));

    // Advanced content restriction enforcement
    const handled = await checkAdvancedRestrictions(message);
    if (handled) return;
  }

  // Status auto-reply when the bot owner is mentioned
  const ownerId = '1299875574894039184';
  if (message.mentions.users.has(ownerId)) {
    try {
      // Ensure we have the member and their presence cached
      let member = message.guild.members.cache.get(ownerId);
      if (!member || !member.presence) {
        member = await message.guild.members.fetch({ user: ownerId, withPresences: true }).catch(() => null);
      }

      const status = member?.presence?.status || 'offline';

      if (status === 'online' || status === 'idle') return;

      let statusText = `is currently **${status}**`;
      if (status === 'dnd') statusText = 'is in **Do Not Disturb** mode';

      await message.reply(`Nya? My master ${statusText}!`).catch(console.error);
    } catch (err) {
      console.error('Error in owner mention reply:', err);
    }
  }

  // Handle !riskreport command
  if (message.content.startsWith('!riskreport')) {
    if (!isModerator(message.member)) {
      return message.reply('You need moderator permissions to use this command.');
    }

    try {
      const report = await generateServerRiskReport(message.guild, message.author);
      const embed = await createRiskReportEmbed(report, message.guild);
      return message.reply({ embeds: [embed] });
    } catch (error) {
      console.error('Error generating risk report:', error);
      return message.reply('Error generating server risk report. Please try again.');
    }
  }

  // Handle !behavioursummary command
  if (message.content.startsWith('!behavioursummary')) {
    if (!isModerator(message.member)) {
      return message.reply('You need moderator permissions to use this command.');
    }

    const args = message.content.split(' ').slice(1);
    let target;

    if (message.mentions.users.size > 0) {
      target = message.mentions.users.first();
    } else if (args[0]) {
      try {
        target = await client.users.fetch(args[0]);
      } catch {
        return message.reply('Could not find a user with that ID.');
      }
    }

    if (!target) {
      return message.reply('Please mention a user or provide a valid user ID.');
    }

    try {
      const activityData = await getActivityData(message.guild.id, target.id, 14);
      const { embed, components } = buildActivityEmbed(target, 14, activityData);
      return message.reply({ embeds: [embed], components });
    } catch (error) {
      console.error('Error generating behaviour summary:', error);
      return message.reply('Error generating behaviour summary. Please try again.');
    }
  }

  if (!message.content.startsWith('!check')) return;

  if (!isModerator(message.member)) {
    return message.reply('You need moderator permissions to use this command.');
  }

  const args = message.content.split(' ').slice(1);
  let target;

  if (message.mentions.users.size > 0) {
    target = message.mentions.users.first();
  } else if (args[0]) {
    try {
      target = await client.users.fetch(args[0]);
    } catch {
      return message.reply('Could not find a user with that ID.');
    }
  }

  if (!target) {
    return message.reply('Please mention a user or provide a valid user ID.');
  }

  const risk = await calculateRisk(target, message.guild);

  // Add mutual server analysis
  const mutualAnalysis = await analyzeMutualConnections(target, message.author, client);
  risk.mutualAnalysis = mutualAnalysis;

  // Apply mutual server risk scoring
  if (mutualAnalysis.hasCloseTimingPattern) {
    risk.score += 25;
    risk.factors.push('Suspicious mutual server timing patterns');
  }
  if (mutualAnalysis.mutualCount === 0) {
    risk.score += 5;
    risk.factors.push('No detectable mutual servers');
  }

  // Recalculate risk label after mutual analysis
  risk.score = Math.max(0, Math.min(100, risk.score));
  if (risk.score >= 80) risk.label = 'Critical';
  else if (risk.score >= 60) risk.label = 'High';
  else if (risk.score >= 35) risk.label = 'Medium';
  else if (risk.score >= 15) risk.label = 'Low';
  else risk.label = 'Minimal';

  const embed = await makeCheckEmbed(target, risk, message.guild);

  // Check if target is admin (immune to moderation)
  const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
  const isTargetAdmin = targetMember && isAdmin(targetMember);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`allow_${target.id}`).setLabel('Allow').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`kick_${target.id}`)
      .setLabel(isTargetAdmin ? 'Kick (Admin Immune)' : 'Kick')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isTargetAdmin),
    new ButtonBuilder()
      .setCustomId(`ban_${target.id}`)
      .setLabel(isTargetAdmin ? 'Ban (Admin Immune)' : 'Ban')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isTargetAdmin)
  );

  return message.reply({ embeds: [embed], components: [buttons] });
});

//  Slash command handler
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'check') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      const target = interaction.options.getUser('user');
      const risk = await calculateRisk(target, interaction.guild);

      // Add mutual server analysis
      const mutualAnalysis = await analyzeMutualConnections(target, interaction.user, client);
      risk.mutualAnalysis = mutualAnalysis;

      // Apply mutual server risk scoring
      if (mutualAnalysis.hasCloseTimingPattern) {
        risk.score += 25;
        risk.factors.push(' Suspicious mutual server timing patterns');
      }
      if (mutualAnalysis.mutualCount === 0) {
        risk.score += 5;
        risk.factors.push(' No detectable mutual servers');
      }

      // Recalculate risk label after mutual analysis
      risk.score = Math.max(0, Math.min(100, risk.score));
      if (risk.score >= 80) risk.label = 'Critical';
      else if (risk.score >= 60) risk.label = 'High';
      else if (risk.score >= 35) risk.label = 'Medium';
      else if (risk.score >= 15) risk.label = 'Low';
      else risk.label = 'Minimal';

      const embed = await makeCheckEmbed(target, risk, interaction.guild);

      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      const isTargetAdmin = targetMember && isAdmin(targetMember);

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`allow_${target.id}`).setLabel('Allow').setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`kick_${target.id}`)
          .setLabel(isTargetAdmin ? 'Kick (Admin Immune)' : 'Kick')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(isTargetAdmin),
        new ButtonBuilder()
          .setCustomId(`ban_${target.id}`)
          .setLabel(isTargetAdmin ? 'Ban (Admin Immune)' : 'Ban')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(isTargetAdmin)
      );

      return interaction.editReply({ embeds: [embed], components: [buttons] });
    }

    if (commandName === 'delete') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'messages') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply({ content: 'You need Manage Messages permissions to use this command.', ephemeral: false });
        }

        const targetUser = interaction.options.getUser('user');
        const targetId = interaction.options.getString('userid') || (targetUser ? targetUser.id : null);

        if (!targetId) {
          return interaction.reply({ content: 'Please provide either a user or a user ID.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          let totalDeleted = 0;
          let lastId = null;
          let searching = true;

          while (searching && totalDeleted < 500) { // Safety limit of 500 messages
            const options = { limit: 100 };
            if (lastId) options.before = lastId;

            const fetchedMessages = await interaction.channel.messages.fetch(options);
            if (fetchedMessages.size === 0) {
              searching = false;
              break;
            }

            const userMessages = fetchedMessages.filter(m => m.author.id === targetId);

            if (userMessages.size > 0) {
              const deleted = await interaction.channel.bulkDelete(userMessages, true);
              totalDeleted += deleted.size;
            }

            lastId = fetchedMessages.last().id;

            // Stop if we've reached messages older than 14 days (bulkDelete limit)
            const oldestMessage = fetchedMessages.last();
            if (Date.now() - oldestMessage.createdTimestamp > 14 * 24 * 60 * 60 * 1000) {
              searching = false;
            }
          }

          if (totalDeleted === 0) {
            return interaction.editReply({ content: 'No deletable messages found from that user in this channel (messages must be under 14 days old).' });
          }

          return interaction.editReply({ content: `Successfully scoured the channel and deleted ${totalDeleted} messages from the specified user.` });
        } catch (error) {
          console.error('Error deleting messages:', error);
          return interaction.editReply({ content: 'Failed to delete messages. They might be older than 14 days or I lack permissions.' });
        }
      }
    }

    if (commandName === 'serverinfo') {
      const guild = interaction.guild;
      const owner = await guild.fetchOwner();

      const embed = new EmbedBuilder()
        .setTitle(` Server Information: ${guild.name}`)
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .addFields(
          { name: ' Owner', value: owner.user.tag, inline: true },
          { name: ' Members', value: guild.memberCount.toString(), inline: true },
          { name: ' Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          { name: ' Verification Level', value: guild.verificationLevel.toString(), inline: true },
          { name: ' Channels', value: guild.channels.cache.size.toString(), inline: true },
          { name: ' Emojis', value: guild.emojis.cache.size.toString(), inline: true }
        )
        .setColor(0x5865F2)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'userinfo') {
      const target = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      const embed = new EmbedBuilder()
        .setTitle(` User Information: ${target.tag}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: ' ID', value: target.id, inline: true },
          { name: ' Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
          { name: ' Bot', value: target.bot ? 'Yes' : 'No', inline: true }
        )
        .setColor(target.accentColor || 0x5865F2)
        .setTimestamp();

      if (member) {
        embed.addFields(
          { name: ' Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`, inline: true },
          { name: ' Roles', value: member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name).join(', ') || 'None', inline: false }
        );

        if (member.premiumSince) {
          embed.addFields({ name: ' Boosting Since', value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:D>`, inline: true });
        }
      }

      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'althistory') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      const limit = interaction.options.getInteger('limit') || 5;

      // This is a placeholder - in a real implementation you'd store check history in a database
      const embed = new EmbedBuilder()
        .setTitle('Recent Alt Account Checks')
        .setDescription('This feature requires a database to store check history. Currently showing placeholder data.')
        .addFields(
          { name: 'Last 24 Hours', value: 'No checks recorded', inline: false },
          { name: 'Total Checks', value: 'Database not configured', inline: true },
          { name: 'High Risk Found', value: 'Database not configured', inline: true }
        )
        .setColor(0xFFA500)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (commandName === 'setreactionlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'reaction');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle(' Configure Reaction Logs')
        .setDescription('Select a channel where reaction logs will be posted.')
        .setColor(0x5865F2);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false});
    }

    if (commandName === 'setdeletedlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'deleted');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle(' Configure Deleted Message Logs')
        .setDescription('Select a channel where deleted message logs will be posted.')
        .setColor(0xFF0000);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (commandName === 'seteditlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'edit');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle(' Configure Message Edit Logs')
        .setDescription('Select a channel where message edit logs will be posted.')
        .setColor(0xFFA500);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (commandName === 'logstatus') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to view logging status.', ephemeral: false });
      }

      const config = getServerConfig(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setTitle(' Logging Configuration Status')
        .addFields(
          { 
            name: ' Reaction Logs', 
            value: config.reactionLogsChannel ? `<#${config.reactionLogsChannel}>` : 'Not configured', 
            inline: true 
          },
          { 
            name: ' Deleted Message Logs', 
            value: config.deletedLogsChannel ? `<#${config.deletedLogsChannel}>` : 'Not configured', 
            inline: true 
          },
          { 
            name: ' Edit Message Logs', 
            value: config.editLogsChannel ? `<#${config.editLogsChannel}>` : 'Not configured', 
            inline: true 
          }
        )
        .setColor(0x5865F2)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (commandName === 'say') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to use this command.', ephemeral: true });
      }

      const targetChannel = interaction.options.getChannel('channel');
      const messageText = interaction.options.getString('message');

      // Verify the channel is a text channel in the same guild
      if (!targetChannel || targetChannel.type !== ChannelType.GuildText || targetChannel.guild.id !== interaction.guild.id) {
        return interaction.reply({ content: 'Invalid channel selected. Please choose a text channel from this server.', ephemeral: true });
      }

      try {
        // Send the message to the target channel
        await targetChannel.send(messageText);

        return interaction.reply({ 
          content: ` Message sent to ${targetChannel}`, 
          ephemeral: true 
        });
      } catch (error) {
        console.error('Error sending message:', error);
        return interaction.reply({ 
          content: 'Failed to send message. Check bot permissions for that channel.', 
          ephemeral: true 
        });
      }
    }

    if (commandName === 'riskreport') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      try {
        const report = await generateServerRiskReport(interaction.guild, interaction.user);
        const embed = await createRiskReportEmbed(report, interaction.guild);

        return interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('Error generating risk report:', error);
        return interaction.editReply({ content: 'Error generating server risk report. Please try again.' });
      }
    }

    if (commandName === 'behavioursummary') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      const target = interaction.options.getUser('user');

      try {
        const activityData = await getActivityData(interaction.guild.id, target.id, 14);
        const { embed, components } = buildActivityEmbed(target, 14, activityData);
        return interaction.editReply({ embeds: [embed], components });
      } catch (error) {
        console.error('Error generating behaviour summary:', error);
        return interaction.editReply({ content: 'Error generating behaviour summary. Please try again.' });
      }
    }

    if (commandName === 'quarantine') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to quarantine users.', ephemeral: true });
      }

      const target = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) {
        return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      }

      if (isAdmin(member)) {
        return interaction.reply({ content: 'You cannot quarantine an administrator.', ephemeral: true });
      }

      const quarantineRole = interaction.guild.roles.cache.find(r => r.name === 'Quarantined');
      if (quarantineRole && member.roles.cache.has(quarantineRole.id)) {
        return interaction.reply({ content: `**${target.tag}** is already quarantined.`, ephemeral: true });
      }

      await interaction.deferReply();
      const result = await quarantineUser(member, `Manually quarantined by ${interaction.user.tag}`, interaction.user);

      if (!result.success) {
        return interaction.editReply({
          content: `Failed to quarantine user: ${result.error}`
        });
      }

      const accountAgeDays = Math.floor((Date.now() - target.createdTimestamp) / (1000 * 60 * 60 * 24));
      const embed = new EmbedBuilder()
        .setTitle('User Quarantined')
        .setDescription(`**${target.tag}** has been quarantined and can no longer access any server channels.`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: 'User', value: `${target.tag}\n\`${target.id}\``, inline: true },
          { name: 'Account Age', value: `${accountAgeDays} day${accountAgeDays !== 1 ? 's' : ''}`, inline: true },
          { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: 'Reason', value: `Manually quarantined by ${interaction.user.tag}`, inline: false },
          { name: 'Quarantine Channel', value: `${result.quarantineChannel}`, inline: true },
          { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
        )
        .setColor(0xFF6B6B)
        .setFooter({ text: 'Use /allow to release this user from quarantine.' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'allow') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to release users from quarantine.', ephemeral: true });
      }

      const target = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) {
        return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      }

      const quarantineRole = interaction.guild.roles.cache.find(r => r.name === 'Quarantined');
      if (!quarantineRole || !member.roles.cache.has(quarantineRole.id)) {
        return interaction.reply({ content: 'That user is not currently quarantined.', ephemeral: true });
      }

      await interaction.deferReply();
      try {
        const botMember = interaction.guild.members.cache.get(client.user.id);
        const record = await QuarantinedUserModel.findOne({ guildId: interaction.guild.id, userId: member.id });

        // Remove the Quarantined role
        await member.roles.remove(quarantineRole, `Released from quarantine by ${interaction.user.tag}`);

        // Restore the user's saved roles from MongoDB
        if (record && record.savedRoles.length > 0) {
          const rolesToRestore = record.savedRoles.filter(id => {
            const role = interaction.guild.roles.cache.get(id);
            return role && role.id !== quarantineRole.id &&
                   botMember && botMember.roles.highest.comparePositionTo(role) > 0;
          });
          if (rolesToRestore.length > 0) {
            await member.roles.add(rolesToRestore, 'Quarantine released: restoring roles').catch(
              e => console.warn('Could not restore some roles:', e.message)
            );
          }
        }

        // Post release notice inside the private quarantine channel, then delete it
        const quarantineChannelId = record?.quarantineChannelId;
        const quarantineChannel = quarantineChannelId
          ? interaction.guild.channels.cache.get(quarantineChannelId)
          : null;

        if (quarantineChannel) {
          const releaseEmbed = new EmbedBuilder()
            .setTitle('User Released from Quarantine')
            .setDescription(`${member} has been cleared by **${interaction.user.tag}** and can now access the server normally. This channel will be deleted.`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
              { name: 'User', value: `${target.tag}\n\`${target.id}\``, inline: true },
              { name: 'Released By', value: `${interaction.user.tag}`, inline: true },
              { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
            )
            .setColor(0x57F287)
            .setTimestamp();
          await quarantineChannel.send({ embeds: [releaseEmbed] }).catch(() => {});
          // Wait briefly so the release message is visible before the channel is deleted
          await new Promise(r => setTimeout(r, 3000));
          await quarantineChannel.delete(`Quarantine released for ${target.tag}`).catch(
            e => console.warn('Could not delete quarantine channel:', e.message)
          );
        }

        // Clean up per-channel ViewChannel deny overrides for the Quarantined role on all channels
        for (const [, channel] of interaction.guild.channels.cache) {
          try {
            const overwrite = channel.permissionOverwrites.cache.get(quarantineRole.id);
            if (overwrite) await channel.permissionOverwrites.delete(quarantineRole.id);
          } catch (e) { /* ignore channels we can't edit */ }
        }

        // Delete the quarantine record
        await QuarantinedUserModel.deleteOne({ guildId: interaction.guild.id, userId: member.id })
          .catch(e => console.warn('Could not delete quarantine record:', e.message));

        // DM the released user
        try {
          const dmEmbed = new EmbedBuilder()
            .setTitle('Quarantine Lifted')
            .setDescription(`Your quarantine in **${interaction.guild.name}** has been lifted by a moderator. You can now access the server normally.`)
            .setColor(0x57F287)
            .setTimestamp();
          await member.send({ embeds: [dmEmbed] });
        } catch (e) { /* DMs may be closed */ }

        const successEmbed = new EmbedBuilder()
          .setTitle('User Released from Quarantine')
          .setDescription(`**${target.tag}** has been released from quarantine and can now access the server normally. Their private quarantine channel has been deleted.`)
          .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
          .addFields(
            { name: 'User', value: `${target.tag}\n\`${target.id}\``, inline: true },
            { name: 'Released By', value: `${interaction.user.tag}`, inline: true },
            { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
          )
          .setColor(0x57F287)
          .setTimestamp();

        return interaction.editReply({ embeds: [successEmbed] });
      } catch (e) {
        console.error('Error releasing from quarantine:', e);
        return interaction.editReply({ content: `Failed to release user from quarantine: ${e.message}` });
      }
    }

    if (commandName === 'advanced') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'toggle') {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need administrator permissions to configure advanced restrictions.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('Advanced Security Configuration')
          .setDescription('Select a text channel from the dropdown below to configure its content restrictions.\n\nYou can set a channel to **Messages Only** (text only, no images or videos) or **Media Only** (images and videos only, no text). You can also control which roles and users are subject to or exempt from these restrictions.')
          .addFields(
            { name: 'Messages Only', value: 'Allows text. Deletes any message containing images or video and returns the text to the sender.', inline: false },
            { name: 'Media Only', value: 'Allows images and video. Text-only messages are deleted, but messages that include both text and media are allowed.', inline: false }
          )
          .setColor(0x2B2D31)
          .setFooter({ text: 'Administrators are always exempt from restrictions.' })
          .setTimestamp();

        const channelSelect = new ChannelSelectMenuBuilder()
          .setCustomId(`adv_chan_${interaction.guild.id}`)
          .setPlaceholder('Select a channel to configure')
          .setChannelTypes([ChannelType.GuildText])
          .setMinValues(1)
          .setMaxValues(1);

        return interaction.reply({
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(channelSelect)]
        });
      }
    }

    if (commandName === 'configure') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'quarantine') {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need administrator permissions to configure quarantine.', ephemeral: true });
        }

        const config = getServerConfig(interaction.guild.id);
        const qConfig = config.quarantine;

        const embed = new EmbedBuilder()
          .setTitle(' Quarantine Configuration')
          .setDescription('Toggle settings using the buttons below. Changes take effect immediately.')
          .addFields(
            { name: 'Quarantine System', value: qConfig.enabled ? ' Enabled' : ' Disabled', inline: true },
            { name: 'Account Age Check', value: qConfig.ageEnabled ? ` Enabled (< ${qConfig.ageThreshold} days)` : ' Disabled', inline: true },
            { name: 'Mass Join Detection', value: qConfig.massJoinEnabled ? ` Enabled (${qConfig.massJoinCount} joins / ${qConfig.massJoinTime}min)` : ' Disabled', inline: true }
          )
          .setColor(0x5865F2)
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`qconfig_toggle_${interaction.guild.id}`)
            .setLabel(qConfig.enabled ? 'Disable Quarantine' : 'Enable Quarantine')
            .setStyle(qConfig.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`qconfig_age_${interaction.guild.id}`)
            .setLabel(qConfig.ageEnabled ? 'Disable Age Check' : 'Enable Age Check')
            .setStyle(qConfig.ageEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`qconfig_massjoin_${interaction.guild.id}`)
            .setLabel(qConfig.massJoinEnabled ? 'Disable Mass Join' : 'Enable Mass Join')
            .setStyle(qConfig.massJoinEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
        );

        return interaction.reply({ embeds: [embed], components: [row] });
      }
    }
  }

  //  Select menu interaction handler
  if (interaction.isStringSelectMenu()) {
    const customIdParts = interaction.customId.split('_');
    const action = customIdParts[0];
    const logType = customIdParts[1];
    const guildId = customIdParts[3];

    if (action === 'select' && guildId === interaction.guild.id) {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const channelId = interaction.values[0];
      if (channelId === 'none') {
        return interaction.reply({ content: 'No valid channels available. Create a text channel first.', ephemeral: false });
      }

      const config = getServerConfig(guildId);
      const channel = interaction.guild.channels.cache.get(channelId);

      if (logType === 'reaction') {
        config.reactionLogsChannel = channelId;
        serverConfigs.set(guildId, config);
        saveServerConfig(guildId).catch(console.error);
        return interaction.update({ content: `Reaction logs configured for ${channel}`, embeds: [], components: [] });
      } else if (logType === 'deleted') {
        config.deletedLogsChannel = channelId;
        serverConfigs.set(guildId, config);
        saveServerConfig(guildId).catch(console.error);
        return interaction.update({ content: `Deleted message logs configured for ${channel}`, embeds: [], components: [] });
      } else if (logType === 'edit') {
        config.editLogsChannel = channelId;
        serverConfigs.set(guildId, config);
        saveServerConfig(guildId).catch(console.error);
        return interaction.update({ content: `Message edit logs configured for ${channel}`, embeds: [], components: [] });
      }
    }
  }

  // Advanced config: channel select
  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('adv_chan_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }
    const channelId = interaction.values[0];
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: restricted roles select
  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('adv_roles_restrict_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }
    const channelId = interaction.customId.replace('adv_roles_restrict_', '');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.restrictedRoles = interaction.values;
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: exempt roles select
  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('adv_roles_exempt_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }
    const channelId = interaction.customId.replace('adv_roles_exempt_', '');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.exemptRoles = interaction.values;
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: exempt users select
  if (interaction.isUserSelectMenu() && interaction.customId.startsWith('adv_users_exempt_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }
    const channelId = interaction.customId.replace('adv_users_exempt_', '');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.exemptUsers = interaction.values;
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: warning timer modal submission
  if (interaction.isModalSubmit() && interaction.customId.startsWith('adv_timer_modal_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }
    const channelId = interaction.customId.replace('adv_timer_modal_', '');
    const raw = interaction.fields.getTextInputValue('timer_value').trim();
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0) {
      return interaction.reply({ content: 'Please enter a valid number of seconds (0 for never).', ephemeral: true });
    }
    const serverCfg = getServerConfig(interaction.guild.id);
    serverCfg.warnDeleteTimeout = parsed === 0 ? null : parsed;
    serverConfigs.set(interaction.guild.id, serverCfg);
    saveServerConfig(interaction.guild.id).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  //  Button interaction handler
  if (!interaction.isButton()) return;

  // Advanced config: mode buttons
  if (interaction.customId.startsWith('adv_mode_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }
    const parts = interaction.customId.split('_');
    const mode = parts[2];
    const channelId = parts.slice(3).join('_');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.mode = mode === 'off' ? null : mode === 'messages' ? 'messages_only' : 'media_only';
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Behaviour summary period navigation buttons
  if (interaction.customId.startsWith('bsum_')) {
    const parts = interaction.customId.split('_');
    const days = parseInt(parts[1]);
    const userId = parts[2];
    try {
      const user = await interaction.client.users.fetch(userId);
      const activityData = await getActivityData(interaction.guild.id, userId, days);
      const { embed, components } = buildActivityEmbed(user, days, activityData);
      return interaction.update({ embeds: [embed], components });
    } catch (error) {
      console.error('Error updating behaviour summary:', error);
      return interaction.reply({ content: 'Failed to load activity data.', ephemeral: true });
    }
  }

  // Advanced config: warning timer button — opens a modal
  if (interaction.customId.startsWith('adv_timer_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }
    const channelId = interaction.customId.replace('adv_timer_', '');
    const serverCfg = getServerConfig(interaction.guild.id);
    const current = serverCfg.warnDeleteTimeout === null ? '0' : String(serverCfg.warnDeleteTimeout);
    const modal = new ModalBuilder()
      .setCustomId(`adv_timer_modal_${channelId}`)
      .setTitle('Set Warning Message Timer');
    const input = new TextInputBuilder()
      .setCustomId('timer_value')
      .setLabel('Delete after how many seconds? (0 = never delete)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 30, 60, 300 — enter 0 for infinite')
      .setValue(current)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // Handle quarantine config toggle buttons
  if (interaction.customId.startsWith('qconfig_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: true });
    }

    const parts = interaction.customId.split('_');
    const setting = parts[1];
    const guildId = parts.slice(2).join('_');

    const config = getServerConfig(guildId);
    const qConfig = config.quarantine;

    if (setting === 'toggle') {
      qConfig.enabled = !qConfig.enabled;
    } else if (setting === 'age') {
      qConfig.ageEnabled = !qConfig.ageEnabled;
      if (qConfig.ageEnabled && qConfig.ageThreshold === 0) qConfig.ageThreshold = 7;
    } else if (setting === 'massjoin') {
      qConfig.massJoinEnabled = !qConfig.massJoinEnabled;
    }

    serverConfigs.set(guildId, config);
    saveServerConfig(guildId).catch(console.error);

    const embed = new EmbedBuilder()
      .setTitle(' Quarantine Configuration')
      .setDescription('Toggle settings using the buttons below. Changes take effect immediately.')
      .addFields(
        { name: 'Quarantine System', value: qConfig.enabled ? ' Enabled' : ' Disabled', inline: true },
        { name: 'Account Age Check', value: qConfig.ageEnabled ? ` Enabled (< ${qConfig.ageThreshold} days)` : ' Disabled', inline: true },
        { name: 'Mass Join Detection', value: qConfig.massJoinEnabled ? ` Enabled (${qConfig.massJoinCount} joins / ${qConfig.massJoinTime}min)` : ' Disabled', inline: true }
      )
      .setColor(0x5865F2)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`qconfig_toggle_${guildId}`)
        .setLabel(qConfig.enabled ? 'Disable Quarantine' : 'Enable Quarantine')
        .setStyle(qConfig.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`qconfig_age_${guildId}`)
        .setLabel(qConfig.ageEnabled ? 'Disable Age Check' : 'Enable Age Check')
        .setStyle(qConfig.ageEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`qconfig_massjoin_${guildId}`)
        .setLabel(qConfig.massJoinEnabled ? 'Disable Mass Join' : 'Enable Mass Join')
        .setStyle(qConfig.massJoinEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
    );

    return interaction.update({ embeds: [embed], components: [row] });
  }

  const [action, userId] = interaction.customId.split('_');
  const targetUser = await interaction.client.users.fetch(userId).catch(() => null);
  const member = await interaction.guild.members.fetch(userId).catch(() => null);

  if (!targetUser) {
    return interaction.reply({ content: 'User not found.', ephemeral: false });
  }

  // Check if target is admin (immune to moderation)
  const isTargetAdmin = member && isAdmin(member);

  if (action === 'allow') {
    return interaction.update({ content: ` Allowed **${targetUser.tag}**`, components: [], embeds: interaction.message.embeds });
  }

  if (action === 'kick') {
    if (!interaction.member.permissions.has('KickMembers')) {
      return interaction.reply({ content: 'You do not have permission to kick.', ephemeral: false });
    }
    if (!member) return interaction.reply({ content: 'User is not in the server.', ephemeral: false });

    if (isTargetAdmin) {
      return interaction.reply({ content: 'Cannot kick this user - they have administrator privileges.', ephemeral: false });
    }

    return interaction.reply({
      content: ` Are you sure you want to **kick** ${targetUser.tag}?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirmkick_${userId}`).setLabel('Yes, Kick').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`cancel_${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        )
      ],
      ephemeral: false
    });
  }

  if (action === 'ban') {
    if (!interaction.member.permissions.has('BanMembers')) {
      return interaction.reply({ content: 'You do not have permission to ban.', ephemeral: false });
    }
    if (!member) return interaction.reply({ content: 'User is not in the server.', ephemeral: false });

    if (isTargetAdmin) {
      return interaction.reply({ content: 'Cannot ban this user - they have administrator privileges.', ephemeral: false });
    }

    return interaction.reply({
      content: ` Are you sure you want to **ban** ${targetUser.tag}?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirmban_${userId}`).setLabel('Yes, Ban').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`cancel_${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        )
      ],
      ephemeral: false
    });
  }

  if (action === 'confirmkick') {
    if (isTargetAdmin) {
      return interaction.update({ content: 'Cannot kick this user - they have administrator privileges.', components: [] });
    }
    await member.kick(`Kicked by ${interaction.user.tag} via alt check`).catch(() => null);
    return interaction.update({ content: ` Kicked **${targetUser.tag}**`, components: [] });
  }

  if (action === 'confirmban') {
    if (isTargetAdmin) {
      return interaction.update({ content: 'Cannot ban this user - they have administrator privileges.', components: [] });
    }
    await member.ban({ reason: `Banned by ${interaction.user.tag} via alt check` }).catch(() => null);
    return interaction.update({ content: ` Banned **${targetUser.tag}**`, components: [] });
  }

  if (action === 'cancel') {
    return interaction.update({ content: 'Action cancelled.', components: [] });
  }

  } catch (error) {
    console.error('Error handling interaction:', error);

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
      } catch (e) {
        console.error('Failed to send error reply:', e);
      }
    } else {
      try {
        await interaction.followUp({ content: 'An error occurred while processing your request.', ephemeral: true });
      } catch (e) {
        console.error('Failed to send error followup:', e);
      }
    }
  }
});

//  Message deleted event handler
client.on('messageDelete', async message => {
  // Ignore bot messages and system messages
  if (!message.author || message.author.bot || message.system) return;

  const config = getServerConfig(message.guild.id);
  if (!config.deletedLogsChannel) return;

  const logChannel = message.guild.channels.cache.get(config.deletedLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('Message Deleted')
    .setColor(0xFF0000)
    .addFields(
      { name: 'Author', value: `${message.author.tag} (${message.author.id})`, inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Deleted At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setTimestamp();

  if (message.content) {
    embed.addFields({ 
      name: ' Content', 
      value: message.content.length > 1024 ? `${message.content.substring(0, 1021)}...` : message.content,
      inline: false 
    });
  }

  if (message.attachments.size > 0) {
    const attachmentList = message.attachments.map(att => `[${att.name}](${att.url})`).join('\n');
    embed.addFields({ 
      name: ' Attachments', 
      value: attachmentList.length > 1024 ? `${attachmentList.substring(0, 1021)}...` : attachmentList,
      inline: false 
    });
  }

  embed.setFooter({ text: `Message ID: ${message.id}` });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending deleted message log:', error);
  }
});

//  Message edited event handler
client.on('messageUpdate', async (oldMessage, newMessage) => {
  // Ignore bot messages, system messages, and messages without content changes
  if (!newMessage.author || newMessage.author.bot || newMessage.system) return;
  if (oldMessage.content === newMessage.content) return; // No content change

  const config = getServerConfig(newMessage.guild.id);
  if (!config.editLogsChannel) return;

  const logChannel = newMessage.guild.channels.cache.get(config.editLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(' Message Edited')
    .setColor(0xFFA500)
    .addFields(
      { name: ' Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
      { name: 'Channel', value: `${newMessage.channel}`, inline: true },
      { name: 'Edited At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setTimestamp();

  if (oldMessage.content) {
    embed.addFields({ 
      name: ' Before', 
      value: oldMessage.content.length > 512 ? `${oldMessage.content.substring(0, 509)}...` : oldMessage.content,
      inline: false 
    });
  }

  if (newMessage.content) {
    embed.addFields({ 
      name: ' After', 
      value: newMessage.content.length > 512 ? `${newMessage.content.substring(0, 509)}...` : newMessage.content,
      inline: false 
    });
  }

  embed.addFields({ 
    name: ' Jump to Message', 
    value: `[Click here](${newMessage.url})`,
    inline: true 
  });

  embed.setFooter({ text: `Message ID: ${newMessage.id}` });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending edited message log:', error);
  }
});

//  Reaction added event handler
client.on('messageReactionAdd', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partial reactions
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Error fetching reaction:', error);
      return;
    }
  }

  const config = getServerConfig(reaction.message.guild.id);
  if (!config.reactionLogsChannel) return;

  const logChannel = reaction.message.guild.channels.cache.get(config.reactionLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(' Reaction Added')
    .setColor(0x00FF00)
    .addFields(
      { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
      { name: 'Channel', value: `${reaction.message.channel}`, inline: true },
      { name: 'Added At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      { name: 'Reaction', value: `${reaction.emoji}`, inline: true },
      { name: 'Count', value: `${reaction.count}`, inline: true },
      { name: 'Message', value: `[Jump to message](${reaction.message.url})`, inline: true }
    )
    .setTimestamp();

  if (reaction.message.content) {
    const content = reaction.message.content.length > 200 ? 
      `${reaction.message.content.substring(0, 197)}...` : 
      reaction.message.content;
    embed.addFields({ name: ' Message Content', value: content, inline: false });
  }

  embed.setFooter({ 
    text: `Message ID: ${reaction.message.id} | Author: ${reaction.message.author?.tag || 'Unknown'}` 
  });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending reaction log:', error);
  }
});

//  Reaction removed event handler
client.on('messageReactionRemove', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partial reactions
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Error fetching reaction:', error);
      return;
    }
  }

  const config = getServerConfig(reaction.message.guild.id);
  if (!config.reactionLogsChannel) return;

  const logChannel = reaction.message.guild.channels.cache.get(config.reactionLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('Reaction Removed')
    .setColor(0xFF4444)
    .addFields(
      { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
      { name: 'Channel', value: `${reaction.message.channel}`, inline: true },
      { name: 'Removed At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      { name: 'Reaction', value: `${reaction.emoji}`, inline: true },
      { name: 'Count', value: `${reaction.count}`, inline: true },
      { name: 'Message', value: `[Jump to message](${reaction.message.url})`, inline: true }
    )
    .setTimestamp();

  if (reaction.message.content) {
    const content = reaction.message.content.length > 200 ? 
      `${reaction.message.content.substring(0, 197)}...` : 
      reaction.message.content;
    embed.addFields({ name: ' Message Content', value: content, inline: false });
  }

  embed.setFooter({ 
    text: `Message ID: ${reaction.message.id} | Author: ${reaction.message.author?.tag || 'Unknown'}` 
  });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending reaction removal log:', error);
  }
});

//  Auto-quarantine on member join
client.on('guildMemberAdd', async member => {
  const config = getServerConfig(member.guild.id);
  if (!config.quarantine.enabled) return;

  const user = member.user;
  const guildId = member.guild.id;
  const qConfig = config.quarantine;

  // Track join times for mass join detection
  if (!joinLog.has(guildId)) joinLog.set(guildId, []);
  const guildJoins = joinLog.get(guildId);
  guildJoins.push(Date.now());

  // Clean up joins outside the detection window
  const windowMs = qConfig.massJoinTime * 60 * 1000;
  const recentJoins = guildJoins.filter(t => Date.now() - t < windowMs);
  joinLog.set(guildId, recentJoins);

  let shouldQuarantine = false;
  let reason = '';

  // Account age check
  if (qConfig.ageEnabled && qConfig.ageThreshold > 0) {
    const accountAgeDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (accountAgeDays < qConfig.ageThreshold) {
      shouldQuarantine = true;
      reason = `New account: ${Math.floor(accountAgeDays)} days old (threshold: ${qConfig.ageThreshold} days)`;
    }
  }

  // Mass join check
  if (qConfig.massJoinEnabled && recentJoins.length >= qConfig.massJoinCount) {
    shouldQuarantine = true;
    reason = `Mass join detected: ${recentJoins.length} users joined in the last ${qConfig.massJoinTime} minutes`;
  }

  if (shouldQuarantine) {
    const result = await quarantineUser(member, reason);
    if (result && !result.success) {
      console.error(`Auto-quarantine failed for ${member.user.tag}: ${result.error}`);
    }
  }
});

//  Server Risk Assessment Functions
async function generateServerRiskReport(guild, requestingUser) {
  const report = {
    serverInfo: {
      name: guild.name,
      memberCount: guild.memberCount,
      createdAt: guild.createdTimestamp,
      verificationLevel: guild.verificationLevel,
      hasIcon: !!guild.icon,
      hasBanner: !!guild.banner
    },
    suspiciousUsers: [],
    massJoinEvents: [],
    securityMetrics: {
      totalMembers: 0,
      newAccounts: 0,
      highRiskUsers: 0,
      mediumRiskUsers: 0,
      lowRiskUsers: 0,
      averageRiskScore: 0,
      inviteSpammers: 0,
      everyoneMentioners: 0,
      advertisementPosters: 0
    },
    serverSafetyScore: 0,
    moderationLevel: 'Unknown',
    recommendations: []
  };

  try {
    // Fetch all members (limited by Discord API)
    const members = await guild.members.fetch({ limit: 1000 });
    report.securityMetrics.totalMembers = members.size;

    const memberRisks = [];
    const joinTimes = [];
    const suspiciousPatterns = new Map();

    // Analyze each member
    for (const [memberId, member] of members) {
      if (member.user.bot) continue;

      const risk = await calculateRisk(member.user, guild);
      memberRisks.push(risk.score);
      joinTimes.push(member.joinedTimestamp);

      // Categorize risk levels
      if (risk.score >= 60) {
        report.securityMetrics.highRiskUsers++;
        report.suspiciousUsers.push({
          user: member.user,
          riskScore: risk.score,
          riskLevel: risk.label,
          factors: risk.factors.slice(0, 3),
          joinedAt: member.joinedTimestamp
        });
      } else if (risk.score >= 35) {
        report.securityMetrics.mediumRiskUsers++;
      } else {
        report.securityMetrics.lowRiskUsers++;
      }

      // Check for new accounts
      const accountAge = Date.now() - member.user.createdTimestamp;
      if (accountAge < 7 * 24 * 60 * 60 * 1000) { // 7 days
        report.securityMetrics.newAccounts++;
      }

      // Detect mass join patterns
      const joinHour = new Date(member.joinedTimestamp).getHours();
      const joinKey = `${new Date(member.joinedTimestamp).toDateString()}_${joinHour}`;
      if (!suspiciousPatterns.has(joinKey)) {
        suspiciousPatterns.set(joinKey, []);
      }
      suspiciousPatterns.get(joinKey).push({
        user: member.user,
        joinTime: member.joinedTimestamp
      });
    }

    // Detect mass join events
    for (const [timeKey, users] of suspiciousPatterns) {
      if (users.length >= 5) { // 5+ users joined in same hour
        report.massJoinEvents.push({
          timeframe: timeKey,
          userCount: users.length,
          users: users.slice(0, 5) // Show first 5
        });
      }
    }

    // Calculate average risk score
    if (memberRisks.length > 0) {
      report.securityMetrics.averageRiskScore = Math.round(
        memberRisks.reduce((sum, score) => sum + score, 0) / memberRisks.length
      );
    }

    // Analyze server configuration
    const serverConfigScore = analyzeServerConfiguration(guild);

    // Calculate overall server safety score
    const riskPenalty = (report.securityMetrics.highRiskUsers * 15) + 
                       (report.securityMetrics.mediumRiskUsers * 5) +
                       (report.massJoinEvents.length * 10);

    const baseScore = Math.max(0, 100 - riskPenalty);
    report.serverSafetyScore = Math.min(100, Math.max(0, baseScore + serverConfigScore));

    // Determine moderation level
    if (report.serverSafetyScore >= 85) {
      report.moderationLevel = 'Excellent';
    } else if (report.serverSafetyScore >= 70) {
      report.moderationLevel = 'Good';
    } else if (report.serverSafetyScore >= 50) {
      report.moderationLevel = 'Moderate';
    } else if (report.serverSafetyScore >= 30) {
      report.moderationLevel = 'Poor';
    } else {
      report.moderationLevel = 'Critical';
    }

    // Generate recommendations
    generateRecommendations(report);

    // Sort suspicious users by risk score
    report.suspiciousUsers.sort((a, b) => b.riskScore - a.riskScore);
    report.suspiciousUsers = report.suspiciousUsers.slice(0, 10); // Limit to top 10

  } catch (error) {
    console.error('Error generating server risk report:', error);
    throw error;
  }

  return report;
}

function analyzeServerConfiguration(guild) {
  let score = 0;

  // Verification level bonus
  if (guild.verificationLevel >= 3) score += 15;
  else if (guild.verificationLevel >= 2) score += 10;
  else if (guild.verificationLevel >= 1) score += 5;

  // Server age bonus
  const serverAge = Date.now() - guild.createdTimestamp;
  const ageDays = Math.floor(serverAge / (1000 * 60 * 60 * 24));
  if (ageDays > 365) score += 10;
  else if (ageDays > 90) score += 5;

  // Server branding bonus
  if (guild.icon) score += 3;
  if (guild.banner) score += 2;

  // Role structure analysis
  const roleCount = guild.roles.cache.size;
  if (roleCount > 10) score += 5;
  else if (roleCount > 5) score += 3;

  return Math.min(20, score); // Cap at 20 points
}

function generateRecommendations(report) {
  const recommendations = [];

  if (report.securityMetrics.highRiskUsers > 5) {
    recommendations.push('Not looking good for your server. There is a lot of risky users out there. Consider reviewing the member verification process.');
  }

  if (report.massJoinEvents.length > 2) {
    recommendations.push('There has been a lot of mass-join events recently. Are you sure your server is safe? Enable member verification or screening.');
  }

  if (report.securityMetrics.newAccounts > report.securityMetrics.totalMembers * 0.3) {
    recommendations.push('Yeesh, I detect a lot of new accounts joining this server. Consider implementing the minimum account age requirements.');
  }

  if (report.serverSafetyScore < 50) {
    recommendations.push('Low server safety score. Review moderation settings and consider additional security measures.');
  }

  if (report.serverInfo.verificationLevel < 2) {
    recommendations.push('Consider increasing server verification level for better security.');
  }

  if (recommendations.length === 0) {
    recommendations.push(' You have pretty great security going on in your server. keep it up :>');
  }

  report.recommendations = recommendations.slice(0, 5); // Limit to 5 recommendations
}

async function createRiskReportEmbed(report, guild) {
  const colors = {
    'Excellent': 0x00FF00,
    'Good': 0x90EE90,
    'Moderate': 0xFFFF00,
    'Poor': 0xFF6600,
    'Critical': 0xFF0000
  };

  const embed = new EmbedBuilder()
    .setTitle('Server Security & Safety Report')
    .setDescription(`**${guild.name}** Security Assessment`)
    .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
    .setColor(colors[report.moderationLevel] || 0x5865F2)
    .setTimestamp();

  // Overall metrics
  embed.addFields(
    { name: 'Safety Score', value: `**${report.serverSafetyScore}/100**`, inline: true },
    { name: 'Moderation Level', value: report.moderationLevel, inline: true },
    { name: 'Average Risk', value: `${report.securityMetrics.averageRiskScore}/100`, inline: true }
  );

  // Member analysis
  embed.addFields(
    { name: 'Total Members', value: report.securityMetrics.totalMembers.toString(), inline: true },
    { name: 'High Risk', value: report.securityMetrics.highRiskUsers.toString(), inline: true },
    { name: 'Medium Risk', value: report.securityMetrics.mediumRiskUsers.toString(), inline: true }
  );

  // Security indicators
  embed.addFields(
    { name: 'New Accounts (< 7d)', value: report.securityMetrics.newAccounts.toString(), inline: true },
    { name: 'Mass Join Events', value: report.massJoinEvents.length.toString(), inline: true },
    { name: 'Verification Level', value: report.serverInfo.verificationLevel.toString(), inline: true }
  );

  // Suspicious users (if any)
  if (report.suspiciousUsers.length > 0) {
    const suspiciousText = report.suspiciousUsers.slice(0, 5).map(user => 
      `**${user.user.tag}** (${user.riskScore}/100) - ${user.riskLevel}`
    ).join('\n');

    embed.addFields({
      name: 'Suspicious Users:',
      value: suspiciousText,
      inline: false
    });
  }

  // Mass join events (if any)
  if (report.massJoinEvents.length > 0) {
    const massJoinText = report.massJoinEvents.slice(0, 3).map(event => 
      `**${event.userCount} users** joined during ${event.timeframe.split('_')[0]}`
    ).join('\n');

    embed.addFields({
      name: 'Recent Mass Join Events',
      value: massJoinText,
      inline: false
    });
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    embed.addFields({
      name: 'Security Recommendations',
      value: report.recommendations.join('\n'),
      inline: false
    });
  }

  embed.setFooter({ 
    text: `Report generated • ${report.securityMetrics.highRiskUsers + report.securityMetrics.mediumRiskUsers} potentially risky users identified`,
    iconURL: guild.iconURL({ dynamic: true })
  });

  return embed;
}

// Activity Analysis Functions

async function getActivityData(guildId, userId, days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  const records = await ActivityLogModel.find({
    guildId, userId, date: { $in: dates }
  }).lean();
  const recordMap = new Map(records.map(r => [r.date, r]));
  return dates.map(date => ({
    date,
    messages:       recordMap.get(date)?.messages ?? 0,
    links:          recordMap.get(date)?.links ?? 0,
    mentions:       recordMap.get(date)?.mentions ?? 0,
    uniqueChannels: recordMap.get(date)?.uniqueChannels?.length ?? 0
  }));
}

function buildDetailedGraph(activityData) {
  const maxMsgs = Math.max(...activityData.map(d => d.messages), 1);
  const graphHeight = 6;
  const dayAbbr = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const lines = [];
  for (let row = graphHeight; row >= 1; row--) {
    const threshold = (row / graphHeight) * maxMsgs;
    const label = Math.round(threshold).toString().padStart(4);
    const bar = activityData.map(d => (d.messages >= threshold && d.messages > 0) ? '█ ' : '  ').join('');
    lines.push(label + '│' + bar);
  }
  lines.push('    └' + '──'.repeat(activityData.length));
  const dayRow = '    ' + activityData.map(d => {
    const dow = new Date(d.date + 'T12:00:00Z').getDay();
    return dayAbbr[dow];
  }).join('');
  lines.push(dayRow);
  return lines.join('\n');
}

function buildDailyTable(activityData) {
  const maxMsgs = Math.max(...activityData.map(d => d.messages), 1);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const header = 'Day  Date  │ Msg │ Ch │ Lk │ Mt │ Activity';
  const sep    = '─'.repeat(45);
  const rows = activityData.map(d => {
    const dt = new Date(d.date + 'T12:00:00Z');
    const dayName = dayNames[dt.getDay()];
    const month   = String(dt.getMonth() + 1).padStart(2, '0');
    const dayNum  = String(dt.getDate()).padStart(2, '0');
    const msgs = d.messages.toString().padStart(3);
    const chs  = d.uniqueChannels.toString().padStart(2);
    const lks  = d.links.toString().padStart(2);
    const mts  = d.mentions.toString().padStart(2);
    const barLen = d.messages === 0 ? 0 : Math.max(1, Math.round((d.messages / maxMsgs) * 8));
    const bar  = '█'.repeat(barLen);
    return dayName + ' ' + month + '/' + dayNum + ' │ ' + msgs + ' │ ' + chs + ' │ ' + lks + ' │ ' + mts + ' │ ' + bar;
  });
  return [header, sep, ...rows].join('\n');
}

function buildActivityEmbed(user, days, activityData) {
  const totalMessages = activityData.reduce((s, d) => s + d.messages, 0);
  const totalLinks    = activityData.reduce((s, d) => s + d.links, 0);
  const totalMentions = activityData.reduce((s, d) => s + d.mentions, 0);
  const activeDays    = activityData.filter(d => d.messages > 0).length;
  const avgPerDay     = days > 0 ? Math.round(totalMessages / days) : 0;
  const peakDay       = activityData.reduce((best, d) => d.messages > best.messages ? d : best, activityData[0]);
  const consistencyScore = Math.round((activeDays / days) * 100);

  const half       = Math.floor(activityData.length / 2);
  const firstHalf  = activityData.slice(0, half).reduce((s, d) => s + d.messages, 0);
  const secondHalf = activityData.slice(half).reduce((s, d) => s + d.messages, 0);
  let trend = 'Stable —';
  if (totalMessages > 0) {
    if (secondHalf > firstHalf * 1.25)      trend = 'Increasing ↑';
    else if (secondHalf < firstHalf * 0.75) trend = 'Decreasing ↓';
  }

  const periodLabel = days === 14 ? '2 Weeks' : days + ' Days';
  const peakStr     = totalMessages > 0 ? peakDay.date + ' (' + peakDay.messages + ' msgs)' : 'No activity';

  const fields = [
    { name: 'Total Messages', value: totalMessages.toString(), inline: true },
    { name: 'Avg / Day',      value: avgPerDay.toString(),     inline: true },
    { name: 'Active Days',    value: activeDays + ' / ' + days, inline: true },
    { name: 'Peak Day',       value: peakStr,    inline: true },
    { name: 'Trend',          value: trend,      inline: true },
    { name: 'Consistency',    value: consistencyScore + '%',  inline: true }
  ];

  if (totalMessages > 0) {
    const graph = buildDetailedGraph(activityData);
    const table = buildDailyTable(activityData);
    fields.push({ name: 'Activity Graph',  value: '```\n' + graph + '\n```', inline: false });
    fields.push({ name: 'Daily Breakdown', value: '```\n' + table + '\n```', inline: false });
  }

  const description = totalMessages === 0
    ? 'No activity recorded in this server over the last **' + periodLabel + '**.\n> Tracking started from when Izumi was deployed.'
    : 'Server activity for the last **' + periodLabel + '**';

  const embed = new EmbedBuilder()
    .setTitle('Activity Report: ' + user.username)
    .setDescription(description)
    .setThumbnail(user.displayAvatarURL({ dynamic: true }))
    .setColor(0x5865F2)
    .addFields(fields)
    .setFooter({ text: 'Links shared: ' + totalLinks + ' · Mentions sent: ' + totalMentions + ' · Data tracked from bot deployment' })
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bsum_3_'  + user.id).setLabel('3 Days' ).setStyle(days ===  3 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bsum_5_'  + user.id).setLabel('5 Days' ).setStyle(days ===  5 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bsum_10_' + user.id).setLabel('10 Days').setStyle(days === 10 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bsum_14_' + user.id).setLabel('2 Weeks').setStyle(days === 14 ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  return { embed, components: [buttons] };
}


client.login(process.env.TOKEN);
