const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ChannelType, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { calculateRisk } = require('./risks');
const { makeCheckEmbed } = require('./embeds');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ]
});

// Storage for server configurations (in production, use a database)
const serverConfigs = new Map();
const joinLog = new Map();
const userFirstMessage = new Map();

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
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
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
  return serverConfigs.get(guildId);
}

async function quarantineUser(member, reason) {
  const guild = member.guild;
  let quarantineRole = guild.roles.cache.find(r => r.name === 'Quarantined');
  if (!quarantineRole) {
    try {
      quarantineRole = await guild.roles.create({
        name: 'Quarantined',
        reason: 'Quarantine system setup'
      });
    } catch (e) {
      console.error('Error creating quarantine role:', e);
      return;
    }
  }

  let quarantineChannel = guild.channels.cache.find(c => c.name === 'quarantine-room');
  if (!quarantineChannel) {
    try {
      quarantineChannel = await guild.channels.create({
        name: 'quarantine-room',
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: quarantineRole.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
          },
          {
            id: client.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
          }
        ]
      });
    } catch (e) {
      console.error('Error creating quarantine channel:', e);
      return;
    }
  }

  try {
    await member.roles.add(quarantineRole);
    await quarantineChannel.send(`⚠️ ${member} has been quarantined.\n**Reason:** ${reason}\nAn admin or moderator will review your account shortly.`);
  } catch (e) {
    console.error('Error adding role or sending message:', e);
  }
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
          suspiciousPatterns.push(`⚠️ Joined ${guild.name} within 24 hours of each other`);
        }

        if (joinDiffHours < 1) {
          suspiciousPatterns.push(`🚨 Joined ${guild.name} within 1 hour of each other`);
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
      suspiciousPatterns: ['❓ Unable to analyze mutual connections'],
      hasCloseTimingPattern: false
    };
  }
}

// ✅ Bot login and slash command registration
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  try {
    console.log('🔄 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
});

// ✅ Message command handler with loading reactions
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // Handle !riskreport command
  if (message.content.startsWith('!riskreport')) {
    if (!isModerator(message.member)) {
      return message.reply('You need moderator permissions to use this command.');
    }

    // Add loading reactions
    const loadingEmojis = ['🔍', '📊', '🛡️', '⚡', '📋'];
    for (const emoji of loadingEmojis) {
      await message.react(emoji).catch(() => {});
    }

    try {
      const report = await generateServerRiskReport(message.guild, message.author);
      const embed = await createRiskReportEmbed(report, message.guild);

      // Remove loading reactions
      for (const emoji of loadingEmojis) {
        await message.reactions.cache.get(emoji)?.users.remove(client.user).catch(() => {});
      }

      return message.reply({ embeds: [embed] });
    } catch (error) {
      console.error('Error generating risk report:', error);
      // Remove loading reactions
      for (const emoji of loadingEmojis) {
        await message.reactions.cache.get(emoji)?.users.remove(client.user).catch(() => {});
      }
      return message.reply('❌ Error generating server risk report. Please try again.');
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
        return message.reply('❌ Could not find a user with that ID.');
      }
    }

    if (!target) {
      return message.reply('Please mention a user or provide a valid user ID.');
    }

    // Add loading reactions
    const loadingEmojis = ['📊', '📈', '🔍', '📋', '⏳'];
    for (const emoji of loadingEmojis) {
      await message.react(emoji).catch(() => {});
    }

    try {
      const behaviorData = await analyzeBehaviorSummary(target, message.guild);
      const embeds = await createBehaviorSummaryEmbeds(behaviorData, target, message.guild);

      // Remove loading reactions
      for (const emoji of loadingEmojis) {
        await message.reactions.cache.get(emoji)?.users.remove(client.user).catch(() => {});
      }

      return message.reply({ embeds });
    } catch (error) {
      console.error('Error generating behavior summary:', error);
      // Remove loading reactions
      for (const emoji of loadingEmojis) {
        await message.reactions.cache.get(emoji)?.users.remove(client.user).catch(() => {});
      }
      return message.reply('❌ Error generating behavior summary. Please try again.');
    }
  }

  if (!message.content.startsWith('!check')) return;

  if (!isModerator(message.member)) {
    return message.reply('You need moderator permissions to use this command.');
  }

  // Add loading reactions
  const loadingEmojis = ['🇱', '🇴', '🇦', '🇩', '🇮', '🇳', '🇬'];
  for (const emoji of loadingEmojis) {
    await message.react(emoji).catch(() => {});
  }

  const args = message.content.split(' ').slice(1);
  let target;

  if (message.mentions.users.size > 0) {
    target = message.mentions.users.first();
  } else if (args[0]) {
    try {
      target = await client.users.fetch(args[0]);
    } catch {
      // Remove loading reactions
      for (const emoji of loadingEmojis) {
        await message.reactions.cache.get(emoji)?.users.remove(client.user).catch(() => {});
      }
      return message.reply('❌ Could not find a user with that ID.');
    }
  }

  if (!target) {
    // Remove loading reactions
    for (const emoji of loadingEmojis) {
      await message.reactions.cache.get(emoji)?.users.remove(client.user).catch(() => {});
    }
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
    new ButtonBuilder().setCustomId(`allow_${target.id}`).setLabel('✅ Allow').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`kick_${target.id}`)
      .setLabel(isTargetAdmin ? '❌ Kick (Admin Immune)' : '❌ Kick')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isTargetAdmin),
    new ButtonBuilder()
      .setCustomId(`ban_${target.id}`)
      .setLabel(isTargetAdmin ? '🔨 Ban (Admin Immune)' : '🔨 Ban')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isTargetAdmin)
  );

  // Remove loading reactions
  for (const emoji of loadingEmojis) {
    await message.reactions.cache.get(emoji)?.users.remove(client.user).catch(() => {});
  }

  return message.reply({ embeds: [embed], components: [buttons] });
});

// ✅ Slash command handler
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'check') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: '🚫 You need moderator permissions to use this command.', ephemeral: false });
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
        risk.factors.push('🚨 Suspicious mutual server timing patterns');
      }
      if (mutualAnalysis.mutualCount === 0) {
        risk.score += 5;
        risk.factors.push('🌐 No detectable mutual servers');
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
        new ButtonBuilder().setCustomId(`allow_${target.id}`).setLabel('✅ Allow').setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`kick_${target.id}`)
          .setLabel(isTargetAdmin ? '❌ Kick (Admin Immune)' : '❌ Kick')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(isTargetAdmin),
        new ButtonBuilder()
          .setCustomId(`ban_${target.id}`)
          .setLabel(isTargetAdmin ? '🔨 Ban (Admin Immune)' : '🔨 Ban')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(isTargetAdmin)
      );

      return interaction.editReply({ embeds: [embed], components: [buttons] });
    }

    if (commandName === 'serverinfo') {
      const guild = interaction.guild;
      const owner = await guild.fetchOwner();

      const embed = new EmbedBuilder()
        .setTitle(`📊 Server Information: ${guild.name}`)
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .addFields(
          { name: '👑 Owner', value: owner.user.tag, inline: true },
          { name: '👥 Members', value: guild.memberCount.toString(), inline: true },
          { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          { name: '🛡️ Verification Level', value: guild.verificationLevel.toString(), inline: true },
          { name: '📝 Channels', value: guild.channels.cache.size.toString(), inline: true },
          { name: '😀 Emojis', value: guild.emojis.cache.size.toString(), inline: true }
        )
        .setColor(0x5865F2)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'userinfo') {
      const target = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      const embed = new EmbedBuilder()
        .setTitle(`👤 User Information: ${target.tag}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: '🆔 ID', value: target.id, inline: true },
          { name: '📅 Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
          { name: '🤖 Bot', value: target.bot ? 'Yes' : 'No', inline: true }
        )
        .setColor(target.accentColor || 0x5865F2)
        .setTimestamp();

      if (member) {
        embed.addFields(
          { name: '📅 Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`, inline: true },
          { name: '🎭 Roles', value: member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name).join(', ') || 'None', inline: false }
        );

        if (member.premiumSince) {
          embed.addFields({ name: '💎 Boosting Since', value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:D>`, inline: true });
        }
      }

      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'althistory') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: '🚫 You need moderator permissions to use this command.', ephemeral: false });
      }

      const limit = interaction.options.getInteger('limit') || 5;

      // This is a placeholder - in a real implementation you'd store check history in a database
      const embed = new EmbedBuilder()
        .setTitle('📜 Recent Alt Account Checks')
        .setDescription('This feature requires a database to store check history. Currently showing placeholder data.')
        .addFields(
          { name: '⏰ Last 24 Hours', value: 'No checks recorded', inline: false },
          { name: '📊 Total Checks', value: 'Database not configured', inline: true },
          { name: '🎯 High Risk Found', value: 'Database not configured', inline: true }
        )
        .setColor(0xFFA500)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (commandName === 'setreactionlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '🚫 You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'reaction');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle('🎭 Configure Reaction Logs')
        .setDescription('Select a channel where reaction logs will be posted.')
        .setColor(0x5865F2);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false});
    }

    if (commandName === 'setdeletedlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '🚫 You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'deleted');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle('🗑️ Configure Deleted Message Logs')
        .setDescription('Select a channel where deleted message logs will be posted.')
        .setColor(0xFF0000);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (commandName === 'seteditlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '🚫 You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'edit');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle('✏️ Configure Message Edit Logs')
        .setDescription('Select a channel where message edit logs will be posted.')
        .setColor(0xFFA500);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (commandName === 'logstatus') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: '🚫 You need moderator permissions to view logging status.', ephemeral: false });
      }

      const config = getServerConfig(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setTitle('📊 Logging Configuration Status')
        .addFields(
          { 
            name: '🎭 Reaction Logs', 
            value: config.reactionLogsChannel ? `<#${config.reactionLogsChannel}>` : 'Not configured', 
            inline: true 
          },
          { 
            name: '🗑️ Deleted Message Logs', 
            value: config.deletedLogsChannel ? `<#${config.deletedLogsChannel}>` : 'Not configured', 
            inline: true 
          },
          { 
            name: '✏️ Edit Message Logs', 
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
        return interaction.reply({ content: '🚫 You need administrator permissions to use this command.', ephemeral: true });
      }

      const targetChannel = interaction.options.getChannel('channel');
      const messageText = interaction.options.getString('message');

      // Verify the channel is a text channel in the same guild
      if (!targetChannel || targetChannel.type !== ChannelType.GuildText || targetChannel.guild.id !== interaction.guild.id) {
        return interaction.reply({ content: '❌ Invalid channel selected. Please choose a text channel from this server.', ephemeral: true });
      }

      try {
        // Send the message to the target channel
        await targetChannel.send(messageText);

        return interaction.reply({ 
          content: `✅ Message sent to ${targetChannel}`, 
          ephemeral: true 
        });
      } catch (error) {
        console.error('Error sending message:', error);
        return interaction.reply({ 
          content: '❌ Failed to send message. Check bot permissions for that channel.', 
          ephemeral: true 
        });
      }
    }

    if (commandName === 'riskreport') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: '🚫 You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      try {
        const report = await generateServerRiskReport(interaction.guild, interaction.user);
        const embed = await createRiskReportEmbed(report, interaction.guild);

        return interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('Error generating risk report:', error);
        return interaction.editReply({ content: '❌ Error generating server risk report. Please try again.' });
      }
    }

    if (commandName === 'behavioursummary') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: '🚫 You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      const target = interaction.options.getUser('user');

      try {
        const behaviorData = await analyzeBehaviorSummary(target, interaction.guild);
        const embeds = await createBehaviorSummaryEmbeds(behaviorData, target, interaction.guild);

        return interaction.editReply({ embeds });
      } catch (error) {
        console.error('Error generating behavior summary:', error);
        return interaction.editReply({ content: '❌ Error generating behavior summary. Please try again.' });
      }
    }
  }

  // ✅ Select menu interaction handler
  if (interaction.isStringSelectMenu()) {
    const customIdParts = interaction.customId.split('_');
    const action = customIdParts[0];
    const logType = customIdParts[1];
    const guildId = customIdParts[3];

    if (action === 'select' && guildId === interaction.guild.id) {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: '🚫 You need administrator permissions to configure logging.', ephemeral: false });
      }

      const channelId = interaction.values[0];
      if (channelId === 'none') {
        return interaction.reply({ content: '❌ No valid channels available. Create a text channel first.', ephemeral: false });
      }

      const config = getServerConfig(guildId);
      const channel = interaction.guild.channels.cache.get(channelId);

      if (logType === 'reaction') {
        config.reactionLogsChannel = channelId;
        serverConfigs.set(guildId, config);

        return interaction.update({ 
          content: `✅ Reaction logs configured for ${channel}`, 
          embeds: [], 
          components: [] 
        });
      } else if (logType === 'deleted') {
        config.deletedLogsChannel = channelId;
        serverConfigs.set(guildId, config);

        return interaction.update({ 
          content: `✅ Deleted message logs configured for ${channel}`, 
          embeds: [], 
          components: [] 
        });
      } else if (logType === 'edit') {
        config.editLogsChannel = channelId;
        serverConfigs.set(guildId, config);

        return interaction.update({ 
          content: `✅ Message edit logs configured for ${channel}`, 
          embeds: [], 
          components: [] 
        });
      }
    }
  }

  // ✅ Button interaction handler
  if (!interaction.isButton()) return;

  const [action, userId] = interaction.customId.split('_');
  const targetUser = await interaction.client.users.fetch(userId).catch(() => null);
  const member = await interaction.guild.members.fetch(userId).catch(() => null);

  if (!targetUser) {
    return interaction.reply({ content: '⚠️ User not found.', ephemeral: false });
  }

  // Check if target is admin (immune to moderation)
  const isTargetAdmin = member && isAdmin(member);

  if (action === 'allow') {
    return interaction.update({ content: `✅ Allowed **${targetUser.tag}**`, components: [], embeds: interaction.message.embeds });
  }

  if (action === 'kick') {
    if (!interaction.member.permissions.has('KickMembers')) {
      return interaction.reply({ content: '🚫 You do not have permission to kick.', ephemeral: false });
    }
    if (!member) return interaction.reply({ content: '⚠️ User is not in the server.', ephemeral: false });

    if (isTargetAdmin) {
      return interaction.reply({ content: '🛡️ Cannot kick this user - they have administrator privileges.', ephemeral: false });
    }

    return interaction.reply({
      content: `⚠️ Are you sure you want to **kick** ${targetUser.tag}?`,
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
      return interaction.reply({ content: '🚫 You do not have permission to ban.', ephemeral: false });
    }
    if (!member) return interaction.reply({ content: '⚠️ User is not in the server.', ephemeral: false });

    if (isTargetAdmin) {
      return interaction.reply({ content: '🛡️ Cannot ban this user - they have administrator privileges.', ephemeral: false });
    }

    return interaction.reply({
      content: `⚠️ Are you sure you want to **ban** ${targetUser.tag}?`,
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
      return interaction.update({ content: '🛡️ Cannot kick this user - they have administrator privileges.', components: [] });
    }
    await member.kick(`Kicked by ${interaction.user.tag} via alt check`).catch(() => null);
    return interaction.update({ content: `👢 Kicked **${targetUser.tag}**`, components: [] });
  }

  if (action === 'confirmban') {
    if (isTargetAdmin) {
      return interaction.update({ content: '🛡️ Cannot ban this user - they have administrator privileges.', components: [] });
    }
    await member.ban({ reason: `Banned by ${interaction.user.tag} via alt check` }).catch(() => null);
    return interaction.update({ content: `🔨 Banned **${targetUser.tag}**`, components: [] });
  }

  if (action === 'cancel') {
    return interaction.update({ content: '❎ Action cancelled.', components: [] });
  }

  } catch (error) {
    console.error('Error handling interaction:', error);

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: '❌ An error occurred while processing your request.', ephemeral: true });
      } catch (e) {
        console.error('Failed to send error reply:', e);
      }
    } else {
      try {
        await interaction.followUp({ content: '❌ An error occurred while processing your request.', ephemeral: true });
      } catch (e) {
        console.error('Failed to send error followup:', e);
      }
    }
  }
});

// ✅ Message deleted event handler
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
      name: '💬 Content', 
      value: message.content.length > 1024 ? `${message.content.substring(0, 1021)}...` : message.content,
      inline: false 
    });
  }

  if (message.attachments.size > 0) {
    const attachmentList = message.attachments.map(att => `[${att.name}](${att.url})`).join('\n');
    embed.addFields({ 
      name: '📎 Attachments', 
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

// ✅ Message edited event handler
client.on('messageUpdate', async (oldMessage, newMessage) => {
  // Ignore bot messages, system messages, and messages without content changes
  if (!newMessage.author || newMessage.author.bot || newMessage.system) return;
  if (oldMessage.content === newMessage.content) return; // No content change

  const config = getServerConfig(newMessage.guild.id);
  if (!config.editLogsChannel) return;

  const logChannel = newMessage.guild.channels.cache.get(config.editLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('✏️ Message Edited')
    .setColor(0xFFA500)
    .addFields(
      { name: '👤 Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
      { name: 'Channel', value: `${newMessage.channel}`, inline: true },
      { name: 'Edited At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setTimestamp();

  if (oldMessage.content) {
    embed.addFields({ 
      name: '📝 Before', 
      value: oldMessage.content.length > 512 ? `${oldMessage.content.substring(0, 509)}...` : oldMessage.content,
      inline: false 
    });
  }

  if (newMessage.content) {
    embed.addFields({ 
      name: '📝 After', 
      value: newMessage.content.length > 512 ? `${newMessage.content.substring(0, 509)}...` : newMessage.content,
      inline: false 
    });
  }

  embed.addFields({ 
    name: '🔗 Jump to Message', 
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

// ✅ Reaction added event handler
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
    .setTitle('🎭 Reaction Added')
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
    embed.addFields({ name: '💬 Message Content', value: content, inline: false });
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

// ✅ Reaction removed event handler
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
    embed.addFields({ name: '💬 Message Content', value: content, inline: false });
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

// ✅ Server Risk Assessment Functions
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
    recommendations.push('✅ You have pretty great security going on in your server. keep it up :>');
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

// ✅ Behavior Analysis Functions
async function analyzeBehaviorSummary(user, guild) {
  const behaviorData = {
    userInfo: {
      id: user.id,
      tag: user.tag,
      joinedAt: null,
      accountCreated: user.createdTimestamp
    },
    messageStats: {
      totalMessages: 0,
      totalLinks: 0,
      totalMentions: 0,
      averageMessagesPerDay: 0,
      peakActivityDay: null,
      peakActivityCount: 0
    },
    activityTimeline: [],
    suspiciousSpikes: [],
    dailyActivity: new Map(),
    analysis: {
      mostActiveHour: null,
      mostActiveDay: null,
      consistencyScore: 0,
      activityPattern: 'Unknown'
    }
  };

  try {
    // Get member information
    const member = await guild.members.fetch(user.id);
    behaviorData.userInfo.joinedAt = member.joinedTimestamp;

    // Calculate days since joining
    const daysSinceJoin = Math.floor((Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24));
    const startDate = new Date(member.joinedTimestamp);

    // Initialize daily activity tracking
    for (let i = 0; i <= daysSinceJoin; i++) {
      const date = new Date(startDate.getTime() + (i * 24 * 60 * 60 * 1000));
      const dateKey = date.toISOString().split('T')[0];
      behaviorData.dailyActivity.set(dateKey, {
        date: dateKey,
        messages: 0,
        links: 0,
        mentions: 0,
        timestamp: date.getTime()
      });
    }

    // Fetch messages from all accessible channels
    const channels = guild.channels.cache.filter(channel => 
      channel.type === 0 && // Text channels
      channel.permissionsFor(guild.members.me).has('ReadMessageHistory')
    );

    console.log(`Analyzing ${channels.size} channels for user ${user.tag}...`);

    for (const [channelId, channel] of channels) {
      try {
        let lastMessageId = null;
        let channelMessageCount = 0;
        const maxMessagesPerChannel = 500; // Limit to prevent rate limiting

        while (channelMessageCount < maxMessagesPerChannel) {
          const options = { limit: 100 };
          if (lastMessageId) options.before = lastMessageId;

          const messages = await channel.messages.fetch(options);
          if (messages.size === 0) break;

          const userMessages = messages.filter(msg => 
            msg.author.id === user.id && 
            msg.createdTimestamp >= member.joinedTimestamp
          );

          for (const [msgId, message] of userMessages) {
            const messageDate = new Date(message.createdTimestamp);
            const dateKey = messageDate.toISOString().split('T')[0];

            if (behaviorData.dailyActivity.has(dateKey)) {
              const dayData = behaviorData.dailyActivity.get(dateKey);
              dayData.messages++;

              // Count links
              const linkPattern = /(https?:\/\/[^\s]+)/g;
              const links = (message.content.match(linkPattern) || []).length;
              dayData.links += links;
              behaviorData.messageStats.totalLinks += links;

              // Count mentions
              const mentions = message.mentions.users.size + message.mentions.roles.size + message.mentions.channels.size;
              dayData.mentions += mentions;
              behaviorData.messageStats.totalMentions += mentions;

              behaviorData.messageStats.totalMessages++;
            }
          }

          channelMessageCount += messages.size;
          lastMessageId = messages.last()?.id;

          // Stop if we've gone past the join date
          const oldestMessage = messages.last();
          if (oldestMessage && oldestMessage.createdTimestamp < member.joinedTimestamp) {
            break;
          }
        }
      } catch (error) {
        console.error(`Error fetching messages from channel ${channel.name}:`, error);
      }
    }

    // Process daily activity data
    const activityArray = Array.from(behaviorData.dailyActivity.values())
      .sort((a, b) => a.timestamp - b.timestamp);

    behaviorData.activityTimeline = activityArray;

    // Calculate statistics
    if (daysSinceJoin > 0) {
      behaviorData.messageStats.averageMessagesPerDay = Math.round(
        behaviorData.messageStats.totalMessages / daysSinceJoin
      );
    }

    // Find peak activity day
    let peakDay = null;
    let peakCount = 0;
    for (const dayData of activityArray) {
      if (dayData.messages > peakCount) {
        peakCount = dayData.messages;
        peakDay = dayData.date;
      }
    }
    behaviorData.messageStats.peakActivityDay = peakDay;
    behaviorData.messageStats.peakActivityCount = peakCount;

    // Detect suspicious activity spikes
    const averageDaily = behaviorData.messageStats.averageMessagesPerDay;
    const spikeThreshold = Math.max(10, averageDaily * 3); // 3x average or minimum 10

    for (let i = 0; i < activityArray.length; i++) {
      const dayData = activityArray[i];
      if (dayData.messages >= spikeThreshold) {
        // Check if it's part of a sustained spike
        let spikeStart = i;
        let spikeEnd = i;

        // Find start of spike
        while (spikeStart > 0 && activityArray[spikeStart - 1].messages > averageDaily * 1.5) {
          spikeStart--;
        }

        // Find end of spike
        while (spikeEnd < activityArray.length - 1 && activityArray[spikeEnd + 1].messages > averageDaily * 1.5) {
          spikeEnd++;
        }

        const spikeData = {
          startDate: activityArray[spikeStart].date,
          endDate: activityArray[spikeEnd].date,
          peakMessages: dayData.messages,
          totalMessages: activityArray.slice(spikeStart, spikeEnd + 1)
            .reduce((sum, day) => sum + day.messages, 0),
          duration: spikeEnd - spikeStart + 1
        };

        // Avoid duplicate spikes
        const existingSpike = behaviorData.suspiciousSpikes.find(spike => 
          spike.startDate === spikeData.startDate
        );

        if (!existingSpike) {
          behaviorData.suspiciousSpikes.push(spikeData);
        }

        // Skip ahead to avoid overlapping spikes
        i = spikeEnd;
      }
    }

    // Analyze activity patterns
    const hourlyActivity = new Map();
    const weeklyActivity = new Map();

    // This would require more detailed timestamp analysis
    // For now, provide basic pattern analysis
    const nonZeroDays = activityArray.filter(day => day.messages > 0).length;
    const consistencyScore = Math.round((nonZeroDays / Math.max(1, daysSinceJoin)) * 100);

    behaviorData.analysis.consistencyScore = consistencyScore;

    if (consistencyScore > 80) {
      behaviorData.analysis.activityPattern = 'Highly Consistent';
    } else if (consistencyScore > 60) {
      behaviorData.analysis.activityPattern = 'Moderately Consistent';
    } else if (consistencyScore > 30) {
      behaviorData.analysis.activityPattern = 'Sporadic';
    } else {
      behaviorData.analysis.activityPattern = 'Inactive/Lurker';
    }

  } catch (error) {
    console.error('Error analysing behaviour summary:', error);
    throw error;
  }

  return behaviorData;
}

async function createBehaviorSummaryEmbeds(behaviorData, user, guild) {
  // Generate activity graph data for complete timeline
  const graphData = generateActivityGraph(behaviorData.activityTimeline);

  // Single comprehensive behavior summary embed
  const embed = new EmbedBuilder()
    .setTitle(`Behaviour Analysis: ${user.tag}`)
    .setDescription(`Complete activity analysis since joining this server`)
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setColor(0x5865F2)
    .setTimestamp();

  // User info section
  const joinDate = behaviorData.userInfo.joinedAt ? 
    `<t:${Math.floor(behaviorData.userInfo.joinedAt / 1000)}:D>` : 'Unknown';
  const daysSinceJoin = behaviorData.userInfo.joinedAt ? 
    Math.floor((Date.now() - behaviorData.userInfo.joinedAt) / (1000 * 60 * 60 * 24)) : 0;

  embed.addFields(
    { name: 'Joined Server', value: joinDate, inline: true },
    { name: 'Days Since Join', value: `${daysSinceJoin} days`, inline: true },
    { name: 'Activity Pattern', value: behaviorData.analysis.activityPattern, inline: true }
  );

  // Message statistics
  embed.addFields(
    { name: 'Total Messages', value: behaviorData.messageStats.totalMessages.toString(), inline: true },
    { name: 'Links Shared', value: behaviorData.messageStats.totalLinks.toString(), inline: true },
    { name: 'Total Mentions', value: behaviorData.messageStats.totalMentions.toString(), inline: true }
  );

  // Activity metrics
  embed.addFields(
    { name: 'Avg Messages/Day', value: behaviorData.messageStats.averageMessagesPerDay.toString(), inline: true },
    { name: 'Peak Activity Day', value: `${behaviorData.messageStats.peakActivityCount} messages`, inline: true },
    { name: 'Consistency Score', value: `${behaviorData.analysis.consistencyScore}%`, inline: true }
  );

  // Complete activity timeline graph
  if (graphData.length > 0) {
    const timelineTitle = daysSinceJoin <= 30 ? 
      `Activity Timeline (${daysSinceJoin} days)` : 
      `Activity Timeline (${daysSinceJoin} days - Showing pattern)`;

    embed.addFields({
      name: `📈 ${timelineTitle}`,
      value: `\`\`\`\n${graphData}\n\`\`\``,
      inline: false
    });
  }

  // Suspicious activity spikes (if any)
  if (behaviorData.suspiciousSpikes.length > 0) {
    const spikesText = behaviorData.suspiciousSpikes.slice(0, 3).map(spike => {
      const duration = spike.duration === 1 ? '1 day' : `${spike.duration} days`;
      return `${spike.startDate} to ${spike.endDate}: ${spike.totalMessages} messages over ${duration}`;
    }).join('\n');

    embed.addFields({
      name: `Suspicious Activity Spikes`,
      value: spikesText,
      inline: false
    });
  }

  return [embed];
}

function generateActivityGraph(timeline) {
  if (timeline.length === 0) return 'No activity data available';

  let dataToGraph = timeline;

  // If timeline is very long, sample it to fit in Discord embed
  if (timeline.length > 60) {
    // Sample every nth day to fit approximately 60 points
    const step = Math.ceil(timeline.length / 60);
    dataToGraph = timeline.filter((_, index) => index % step === 0);
  }

  if (dataToGraph.length === 0) return 'No activity data available';

  const maxMessages = Math.max(...dataToGraph.map(day => day.messages));
  if (maxMessages === 0) return 'No messages found in timeline';

  // Create a simple text-based graph
  const graphLines = [];
  const graphHeight = 8; // Number of rows in graph

  // Create graph rows from top to bottom
  for (let row = graphHeight; row >= 0; row--) {
    let line = '';
    const threshold = (row / graphHeight) * maxMessages;

    for (const day of dataToGraph) {
      if (day.messages >= threshold && day.messages > 0) {
        line += '█';
      } else if (day.messages >= threshold * 0.7 && day.messages > 0) {
        line += '▓';
      } else if (day.messages >= threshold * 0.3 && day.messages > 0) {
        line += '▒';
      } else if (day.messages > 0) {
        line += '░';
      } else {
        line += ' ';
      }
    }

    // Add y-axis label
    const label = Math.round(threshold).toString().padStart(3, ' ');
    graphLines.push(`${label}│${line}`);
  }

  // Add x-axis
  const xAxis = '   └' + '─'.repeat(dataToGraph.length);
  graphLines.push(xAxis);

  // Add date labels for start and end
  if (dataToGraph.length >= 2) {
    const firstDate = dataToGraph[0].date.split('-').slice(1).join('/');
    const lastDate = dataToGraph[dataToGraph.length - 1].date.split('-').slice(1).join('/');
    const spacing = ' '.repeat(Math.max(0, dataToGraph.length - firstDate.length - lastDate.length));
    graphLines.push(`    ${firstDate}${spacing}${lastDate}`);
  }

  // Add summary line
  const totalDays = timeline.length;
  const totalMessages = timeline.reduce((sum, day) => sum + day.messages, 0);
  graphLines.push(`    Total: ${totalMessages} messages over ${totalDays} days`);

  return graphLines.join('\n');
}

client.login(process.env.TOKEN);
