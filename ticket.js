const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');
const mongoose = require('mongoose');

// ---- Schemas ----

const TicketConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  panelMessageId: { type: String, default: null },
  caption: { type: String, default: 'Open a ticket and our team will assist you.' },
  allowedRoles: { type: [String], default: [] }
});
const TicketConfigModel = mongoose.model('IzumiTicketConfig', TicketConfigSchema);

const ActiveTicketSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true, unique: true },
  creatorId: { type: String, required: true },
  locked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const ActiveTicketModel = mongoose.model('IzumiActiveTicket', ActiveTicketSchema);

// Temporary multi-step setup state: guildId -> { channelId, caption }
const setupState = new Map();

// ---- Embed builders ----

function buildTicketPanelEmbed(caption) {
  return new EmbedBuilder()
    .setTitle('Support Tickets')
    .setDescription(caption)
    .setColor(0x2B2D31)
    .setFooter({ text: 'A private channel will be created for you and the support team only.' })
    .setTimestamp();
}

// ---- Slash command handler (/setticket) ----

async function handleSetTicketCommand(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'You need the **Manage Server** permission to configure the ticket system.',
      ephemeral: false
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Ticket System Setup — Step 1 of 3')
    .setDescription(
      'Select the channel where the ticket creation panel will be posted.\n\n' +
      'Members will see an embed and a button in that channel to open a new private ticket with your team.'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Step 1 of 3 — Select a channel' });

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`ticket_setup_chan_${interaction.guild.id}`)
    .setPlaceholder('Select a channel for the ticket panel...')
    .setChannelTypes([ChannelType.GuildText])
    .setMinValues(1)
    .setMaxValues(1);

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(channelSelect)],
    ephemeral: false
  });
}

// ---- Slash command handler (/ticket <subcommand>) ----

async function handleTicketCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channel.id;
  const guildId = interaction.guild.id;

  const ticket = await ActiveTicketModel.findOne({ channelId, guildId });

  if (!ticket) {
    await interaction.reply({
      content: 'This command can only be used inside an active ticket channel.',
      ephemeral: false
    });
    return;
  }

  const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
  const isCreator = interaction.user.id === ticket.creatorId;

  if (subcommand === 'close') {
    await interaction.reply({ content: 'Closing ticket. This channel will be deleted momentarily.' });
    await ActiveTicketModel.deleteOne({ channelId }).catch(() => {});
    await interaction.channel.delete('Ticket closed').catch(() => {});
    return;
  }

  if (subcommand === 'lock') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to lock tickets.', ephemeral: false });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(guildId, { SendMessages: false });
    await ActiveTicketModel.findOneAndUpdate({ channelId }, { locked: true });
    await interaction.reply({ content: 'Ticket locked. Members can no longer send messages in this channel.' });
    return;
  }

  if (subcommand === 'unlock') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to unlock tickets.', ephemeral: false });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(guildId, { SendMessages: null });
    await ActiveTicketModel.findOneAndUpdate({ channelId }, { locked: false });
    await interaction.reply({ content: 'Ticket unlocked. Members can now send messages again.' });
    return;
  }

  if (subcommand === 'roles') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to reconfigure ticket roles.', ephemeral: false });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Reconfigure Ticket Access')
      .setDescription(
        'Select the roles that should have access to this ticket channel.\n\n' +
        'The ticket creator will always retain access regardless of what is selected here.'
      )
      .setColor(0x5865F2);

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`ticket_cfg_roles_${channelId}`)
      .setPlaceholder('Select roles...')
      .setMinValues(0)
      .setMaxValues(25);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(roleSelect)],
      ephemeral: false
    });
    return;
  }
}

// ---- Main interaction router ----
// Returns true if the interaction was handled, false otherwise.

async function handleTicketInteraction(interaction) {
  const { customId } = interaction;
  if (!customId) return false;

  // Step 1: Channel selected during setup
  if (interaction.isChannelSelectMenu() && customId.startsWith('ticket_setup_chan_')) {
    const guildId = customId.replace('ticket_setup_chan_', '');
    const selectedChannelId = interaction.values[0];
    setupState.set(guildId, { channelId: selectedChannelId });

    const modal = new ModalBuilder()
      .setCustomId(`ticket_caption_${guildId}`)
      .setTitle('Ticket Setup — Step 2 of 3');

    const captionInput = new TextInputBuilder()
      .setCustomId('caption')
      .setLabel('Caption shown above the Create Ticket button')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('e.g. Need assistance? Open a ticket and our team will respond promptly.')
      .setRequired(true)
      .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(captionInput));
    await interaction.showModal(modal);
    return true;
  }

  // Step 2: Caption modal submitted
  if (interaction.isModalSubmit() && customId.startsWith('ticket_caption_')) {
    const guildId = customId.replace('ticket_caption_', '');
    const caption = interaction.fields.getTextInputValue('caption');
    const existing = setupState.get(guildId) || {};
    setupState.set(guildId, { ...existing, caption });

    const embed = new EmbedBuilder()
      .setTitle('Ticket System Setup — Step 3 of 3')
      .setDescription(
        'Caption saved.\n\n' +
        'Now select which roles will be able to **view and respond** to all tickets.\n' +
        'The member who opens a ticket will always have access to their own ticket channel regardless of this selection.'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Step 3 of 3 — Select support roles' });

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`ticket_setup_roles_${guildId}`)
      .setPlaceholder('Select one or more support roles...')
      .setMinValues(1)
      .setMaxValues(25);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(roleSelect)],
      ephemeral: false
    });
    return true;
  }

  // Step 3: Support roles selected — finalize setup
  if (interaction.isRoleSelectMenu() && customId.startsWith('ticket_setup_roles_')) {
    const guildId = customId.replace('ticket_setup_roles_', '');
    const state = setupState.get(guildId);

    if (!state || !state.channelId) {
      await interaction.reply({
        content: 'Setup session expired. Please run `/setticket` again.',
        ephemeral: false
      });
      return true;
    }

    const { channelId, caption } = state;
    const allowedRoles = interaction.values;

    // Try to delete a previous panel message if reconfiguring
    try {
      const existingConfig = await TicketConfigModel.findOne({ guildId });
      if (existingConfig?.panelMessageId) {
        const oldChan = interaction.guild.channels.cache.get(existingConfig.channelId);
        if (oldChan) {
          await oldChan.messages
            .fetch(existingConfig.panelMessageId)
            .then(m => m.delete())
            .catch(() => {});
        }
      }
    } catch (_) {}

    const targetChannel = interaction.guild.channels.cache.get(channelId);
    if (!targetChannel) {
      await interaction.reply({
        content: 'The selected channel no longer exists. Please run `/setticket` again and pick a valid channel.',
        ephemeral: false
      });
      return true;
    }

    // Send the panel to the chosen channel
    let panelMsg;
    try {
      const panelEmbed = buildTicketPanelEmbed(caption);
      const createRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_create_${guildId}`)
          .setLabel('Create Ticket')
          .setStyle(ButtonStyle.Primary)
      );
      panelMsg = await targetChannel.send({ embeds: [panelEmbed], components: [createRow] });
    } catch (e) {
      console.error('Ticket panel send error:', e);
      await interaction.reply({
        content: `Failed to post the ticket panel in <#${channelId}>. Please make sure I have permission to send messages and embeds in that channel.`,
        ephemeral: false
      });
      return true;
    }

    // Save config
    await TicketConfigModel.findOneAndUpdate(
      { guildId },
      { guildId, channelId, caption, allowedRoles, panelMessageId: panelMsg.id },
      { upsert: true, new: true }
    );

    setupState.delete(guildId);

    const rolesMentions = allowedRoles.map(r => `<@&${r}>`).join(', ');
    const confirmEmbed = new EmbedBuilder()
      .setTitle('Ticket System Configured')
      .setDescription(`The ticket panel has been posted in <#${channelId}>. Your members can now open tickets.`)
      .addFields(
        { name: 'Caption', value: caption, inline: false },
        { name: 'Support Roles', value: rolesMentions, inline: false }
      )
      .setColor(0x57F287)
      .setTimestamp();

    await interaction.reply({ embeds: [confirmEmbed], ephemeral: false });
    return true;
  }

  // Create ticket button
  if (interaction.isButton() && customId.startsWith('ticket_create_')) {
    const guildId = customId.replace('ticket_create_', '');
    const config = await TicketConfigModel.findOne({ guildId });

    if (!config) {
      await interaction.reply({
        content: 'The ticket system is not properly configured for this server.',
        ephemeral: false
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: false });

    const guild = interaction.guild;
    const creator = interaction.member;
    const botId = guild.members.me ? guild.members.me.id : interaction.client.user.id;

    const safeName =
      'ticket-' +
      (creator.user.username
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 22) || creator.user.id);

    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: creator.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels
        ]
      }
    ];

    for (const roleId of config.allowedRoles) {
      overwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      });
    }

    let ticketChannel;
    try {
      ticketChannel = await guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        topic: `Ticket opened by ${creator.user.tag} — ${creator.user.id}`,
        permissionOverwrites: overwrites
      });
    } catch (e) {
      console.error('Error creating ticket channel:', e);
      await interaction.editReply({
        content: 'Failed to create the ticket channel. Please ensure I have the **Manage Channels** permission.'
      });
      return true;
    }

    const roleMentions = config.allowedRoles.map(r => `<@&${r}>`).join(', ');

    const greetingEmbed = new EmbedBuilder()
      .setTitle('New Ticket — Welcome')
      .setDescription(
        `${creator} — your ticket has been received.\n\n` +
        (roleMentions
          ? `${roleMentions} — a member of the team will be with you shortly. Please describe your matter in the meantime.`
          : 'A member of the team will be with you shortly. Please describe your matter.')
      )
      .setColor(0x5865F2)
      .setTimestamp();

    await ticketChannel.send({
      content: roleMentions || null,
      embeds: [greetingEmbed]
    });

    await ActiveTicketModel.create({
      guildId,
      channelId: ticketChannel.id,
      creatorId: creator.id,
      locked: false
    });

    await interaction.editReply({ content: `Your ticket has been created: ${ticketChannel}` });
    return true;
  }

  // /ticket roles — role select response
  if (interaction.isRoleSelectMenu() && customId.startsWith('ticket_cfg_roles_')) {
    const channelId = customId.replace('ticket_cfg_roles_', '');
    const ticket = await ActiveTicketModel.findOne({ channelId });
    if (!ticket) {
      await interaction.reply({ content: 'Ticket not found in database.', ephemeral: false });
      return true;
    }

    const ticketChannel = interaction.guild.channels.cache.get(channelId);
    if (!ticketChannel) {
      await interaction.reply({ content: 'Ticket channel not found.', ephemeral: false });
      return true;
    }

    const selectedRoles = interaction.values;
    const botId = interaction.guild.members.me ? interaction.guild.members.me.id : interaction.client.user.id;

    for (const [id] of ticketChannel.permissionOverwrites.cache) {
      const isEveryone = id === interaction.guild.id;
      const isBot = id === botId;
      const isCreator = id === ticket.creatorId;
      if (!isEveryone && !isBot && !isCreator) {
        await ticketChannel.permissionOverwrites.delete(id).catch(() => {});
      }
    }

    for (const roleId of selectedRoles) {
      await ticketChannel.permissionOverwrites.edit(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true
      }).catch(() => {});
    }

    const rolesMentions = selectedRoles.length > 0
      ? selectedRoles.map(r => `<@&${r}>`).join(', ')
      : 'None — only the ticket creator can see this channel now.';

    await interaction.reply({
      content: `Ticket access updated. Roles with access: ${rolesMentions}`,
      ephemeral: false
    });
    return true;
  }

  return false;
}

async function loadTicketConfigs() {
  const ticketCount = await TicketConfigModel.countDocuments();
  const activeCount = await ActiveTicketModel.countDocuments();
  console.log(`Ticket system: ${ticketCount} config(s), ${activeCount} active ticket(s) loaded.`);
}

module.exports = {
  handleSetTicketCommand,
  handleTicketCommand,
  handleTicketInteraction,
  loadTicketConfigs
};
