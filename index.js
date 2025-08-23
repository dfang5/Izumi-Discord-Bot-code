const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ChannelType, StringSelectMenuBuilder } = require('discord.js');
const { calculateRisk } = require('./risks');
const { makeCheckEmbed } = require('./embeds');

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
      editLogsChannel: null
    });
  }
  return serverConfigs.get(guildId);
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
          suspiciousPatterns.push(`Joined ${guild.name} within 24 hours of each other`);
        }
        
        if (joinDiffHours < 1) {
          suspiciousPatterns.push(`Joined ${guild.name} within 1 hour of each other`);
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
  if (!message.content.startsWith('!check') || message.author.bot) return;

  if (!isModerator(message.member)) {
    return message.reply('You need moderator permissions to use this command.');
  }

  // Add loading reactions (if this is removed, it won't affect the code in any way. I just put it here because it's funni :>)
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
          { name: 'Owner', value: owner.user.tag, inline: true },
          { name: 'Members', value: guild.memberCount.toString(), inline: true },
          { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          { name: '🛡Verification Level', value: guild.verificationLevel.toString(), inline: true },
          { name: 'Channels', value: guild.channels.cache.size.toString(), inline: true },
          { name: 'Emojis', value: guild.emojis.cache.size.toString(), inline: true }
        )
        .setColor(0x5865F2)
        .setTimestamp();
        
      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'userinfo') {
      const target = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      
      const embed = new EmbedBuilder()
        .setTitle(`User Information: ${target.tag}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: 'ID', value: target.id, inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
          { name: 'Bot', value: target.bot ? 'Yes' : 'No', inline: true }
        )
        .setColor(target.accentColor || 0x5865F2)
        .setTimestamp();
        
      if (member) {
        embed.addFields(
          { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`, inline: true },
          { name: 'Roles', value: member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name).join(', ') || 'None', inline: false }
        );
        
        if (member.premiumSince) {
          embed.addFields({ name: 'Boosting Since', value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:D>`, inline: true });
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
      { name: 'Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
      { name: 'Channel', value: `${newMessage.channel}`, inline: true },
      { name: 'Edited At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setTimestamp();

  if (oldMessage.content) {
    embed.addFields({ 
      name: 'Before', 
      value: oldMessage.content.length > 512 ? `${oldMessage.content.substring(0, 509)}...` : oldMessage.content,
      inline: false 
    });
  }

  if (newMessage.content) {
    embed.addFields({ 
      name: 'After', 
      value: newMessage.content.length > 512 ? `${newMessage.content.substring(0, 509)}...` : newMessage.content,
      inline: false 
    });
  }

  embed.addFields({ 
    name: 'Jump to Message', 
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
    .setTitle('Reaction Added')
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
    embed.addFields({ name: 'Message Content', value: content, inline: false });
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

client.login(process.env.TOKEN);
