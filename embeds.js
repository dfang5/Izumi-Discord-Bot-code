const { EmbedBuilder } = require('discord.js');

async function makeCheckEmbed(user, risk, guild) {
  const days = Math.floor(risk.accountAge / (1000 * 60 * 60 * 24));
  const hours = Math.floor((risk.accountAge % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  // Enhanced color system based on risk level
  const colors = {
    'Critical': 0x8B0000, // Dark red
    'High': 0xFF0000,     // Red
    'Medium': 0xFFA500,   // Orange
    'Low': 0xFFFF00,      // Yellow
    'Minimal': 0x00FF00   // Green
  };

  // Risk level emojis
  const riskEmojis = {
    'Critical': '🚨',
    'High': '⛔',
    'Medium': '⚠️',
    'Low': '🟡',
    'Minimal': '✅'
  };

  const embed = new EmbedBuilder()
    .setTitle(`${riskEmojis[risk.label]} Alt Account Detector Analysis:`)
    .setDescription(`**Target:** ${user.tag} (${user.id})`)
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setColor(colors[risk.label] || 0x5865F2)
    .setTimestamp();

  // Primary metrics row
  embed.addFields(
    { name: 'Risk Score:', value: `**${risk.score}/100** (${risk.label})`, inline: true },
    { name: 'Confidence:', value: `${risk.confidence}%`, inline: true },
    { name: 'Account Age:', value: `${days}d ${hours}h`, inline: true }
  );

  // Account analysis
  embed.addFields(
    { name: 'Account Stability:', value: risk.analysis.accountStability, inline: true },
    { name: 'Profile Complete:', value: `${risk.analysis.profileCompleteness}%`, inline: true },
    { name: 'Server Integration:', value: risk.analysis.serverIntegration, inline: true }
  );

  // Advanced metrics
  if (risk.joinAnalysis) {
    const timeInfo = risk.joinAnalysis.joinDays > 0 ? 
      `${risk.joinAnalysis.joinDays} days ago` : 
      `${risk.joinAnalysis.joinHours} hours ago`;
    
    embed.addFields({
      name: 'Server Credentials:',
      value: `Joined: ${timeInfo}\nRoles: ${risk.joinAnalysis.roles}\nStatus: ${risk.joinAnalysis.permissions}${risk.joinAnalysis.premium ? '\n💎 Server Booster' : ''}`,
      inline: true
    });
  }

  // Activity and legitimacy indicators
  embed.addFields(
    { name: '📊 Activity Score', value: `${risk.activityScore}/100`, inline: true },
    { name: '✅ Legitimacy Signs', value: `${risk.legitimacyIndicators}`, inline: true }
  );

  // Mutual server analysis
  if (risk.mutualAnalysis) {
    const mutualInfo = risk.mutualAnalysis;
    embed.addFields({
      name: 'Mutual Servers:',
      value: `Mutual servers: ${mutualInfo.mutualCount}\n${mutualInfo.hasCloseTimingPattern ? '🚨 Suspicious timing patterns detected' : '✅ No suspicious timing patterns'}`,
      inline: true
    });
    
    // Add suspicious patterns if found
    if (mutualInfo.suspiciousPatterns.length > 0) {
      embed.addFields({
        name: '🔗 Connection Patterns',
        value: mutualInfo.suspiciousPatterns.slice(0, 3).join('\n'),
        inline: false
      });
    }
  }

  // Risk factors (if any)
  if (risk.factors && risk.factors.length > 0) {
    const riskText = risk.factors.slice(0, 10).join('\n');
    embed.addFields({
      name: 'Risk Indicators',
      value: riskText,
      inline: false
    });
  }

  // Positive indicators (if any)
  if (risk.positiveIndicators && risk.positiveIndicators.length > 0) {
    const positiveText = risk.positiveIndicators.slice(0, 6).join('\n');
    embed.addFields({
      name: '✅ Legitimacy Indicators',
      value: positiveText,
      inline: false
    });
  }

  // Advanced verdict
  let verdict = '';
  if (risk.score >= 80) {
    verdict = '**CRITICAL RISK** - Immediate review recommended';
  } else if (risk.score >= 60) {
    verdict = '**HIGH RISK** - Close monitoring advised';
  } else if (risk.score >= 35) {
    verdict = '**MEDIUM RISK** - Proceed with caution';
  } else if (risk.score >= 15) {
    verdict = '**LOW RISK** - Appears legitimate';
  } else {
    verdict = '**MINIMAL RISK** - Highly likely legitimate';
  }

  embed.addFields({
    name: '📋 Final Assessment',
    value: verdict,
    inline: false
  });

  // Enhanced footer
  embed.setFooter({ 
    text: `Analysis: ${risk.riskIndicators} risk factors • ${risk.legitimacyIndicators} positive signs • Checked by Alt Account Detector`,
    iconURL: user.displayAvatarURL({ dynamic: true })
  });

  return embed;
}

module.exports = { makeCheckEmbed };
