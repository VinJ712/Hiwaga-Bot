import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';

import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { sanitizeInput } from '../../utils/validation.js';

const TEXT_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
];

function resolveTargetChannel(interaction) {
  const selected = interaction.options.getChannel('channel');

  if (selected) {
    return selected;
  }

  if (
    !interaction.channel ||
    !TEXT_CHANNEL_TYPES.includes(interaction.channel.type)
  ) {
    return null;
  }

  return interaction.channel;
}

export default {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message with an optional image as the bot')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Message text. Use \\n for a new line.')
        .setRequired(true)
        .setMaxLength(2000),
    )
    .addAttachmentOption((option) =>
      option
        .setName('image')
        .setDescription('An optional image to send with the message')
        .setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to send in (defaults to the current channel)')
        .addChannelTypes(...TEXT_CHANNEL_TYPES)
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  category: 'moderation',

  abuseProtection: {
    maxAttempts: 8,
    windowMs: 60_000,
  },

  async execute(interaction, _config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });

    if (!deferSuccess) {
      logger.warn('Say interaction defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'say',
      });
      return;
    }

    const rawMessage = interaction.options.getString('message', true);

    // Convert typed \n sequences after sanitizing.
    const message = sanitizeInput(rawMessage, 2000)
      .replace(/\\n/g, '\n');

    const image = interaction.options.getAttachment('image');

    if (!message.trim()) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Message cannot be empty.',
      });
    }

    if (image && !image.contentType?.startsWith('image/')) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Please upload an image file, such as PNG, JPG, or GIF.',
      });
    }

    const channel = resolveTargetChannel(interaction);

    if (!channel) {
      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: 'Choose a text channel or run this command in one.',
      });
    }

    const memberPermissions = channel.permissionsFor(interaction.member);
    const botPermissions = channel.permissionsFor(
      interaction.guild.members.me,
    );

    if (
      !memberPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ])
    ) {
      return replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: `You do not have permission to view and send messages in ${channel}.`,
      });
    }

    if (
      !botPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ])
    ) {
      return replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: `I need View Channel and Send Messages permissions in ${channel}.`,
      });
    }

    if (
      image &&
      !memberPermissions?.has(PermissionFlagsBits.AttachFiles)
    ) {
      return replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: `You do not have permission to attach files in ${channel}.`,
      });
    }

    if (
      image &&
      !botPermissions?.has(PermissionFlagsBits.AttachFiles)
    ) {
      return replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: `I need Attach Files permission in ${channel}.`,
      });
    }

    let sentMessage;

    try {
      sentMessage = await channel.send({
        content: message,
        files: image
          ? [{ attachment: image.url, name: image.name }]
          : [],
      });
    } catch (error) {
      logger.error('Failed to send say message', error);

      return replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message:
          'I could not send the message. Check my channel permissions and whether the image exceeds the upload limit.',
      });
    }

    // Logging errors should not prevent confirmation of a successful post.
    try {
      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: 'Bot Message Sent',
          target: `${channel} (${channel.id})`,
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          reason:
            message.length > 200
              ? `${message.slice(0, 197)}...`
              : message,
          metadata: {
            channelId: channel.id,
            messageId: sentMessage.id,
            moderatorId: interaction.user.id,
            messageLength: message.length,
            imageName: image?.name ?? null,
          },
        },
      });
    } catch (error) {
      logger.error('Failed to log say message', error);
    }

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        successEmbed(
          'Message Sent',
          `Posted in ${channel}. [Jump to message](${sentMessage.url})`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
