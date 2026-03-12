// ============================================================
//  🗼 ARKHERON SA — Custom Game Bot
//  Gerencia salas de custom game em tempo real
// ============================================================

require('dotenv').config();
const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  ChannelType, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ]
});

// ─────────────────────────────────────────────
//  CONFIGURAÇÕES
// ─────────────────────────────────────────────
const {
  DISCORD_TOKEN,
  GUILD_ID,
  SALAS_CHANNEL_ID,
  CUSTOM_CATEGORY_ID,
  LOG_CHANNEL_ID,
  MIN_ROLE_ID,
  ADMIN_SALAS_CHANNEL_ID,
} = process.env;

const MIN_VOTES = 8; // Mínimo de votos para fechar a sala

// ─────────────────────────────────────────────
//  MEMÓRIA DE SALAS ATIVAS
//  sala = {
//    id, nome, codigo, vagas, criadorId,
//    membros: Set, embedMessageId,
//    textChannelId, voiceChannelId,
//    votacao: { ativa, sim: Set, nao: Set, messageId },
//    emAndamento: boolean
//  }
// ─────────────────────────────────────────────
const salas = new Map(); // salaId → sala

// ─────────────────────────────────────────────
//  FUNÇÕES AUXILIARES
// ─────────────────────────────────────────────
function gerarId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function log(guild, msg) {
  try {
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) await logChannel.send(`\`[${new Date().toLocaleTimeString('pt-BR')}]\` ${msg}`);
  } catch {}
}

// ─────────────────────────────────────────────
//  BUILDS DE EMBED E BOTÕES
// ─────────────────────────────────────────────
function buildSalaEmbed(sala) {
  const membrosCount = sala.membros.size;
  const vagas = sala.vagas;
  const cheio = membrosCount >= vagas;
  const status = sala.emAndamento ? '🔴 Partida em andamento' : '🟢 Esperando jogadores';

  return new EmbedBuilder()
    .setColor(sala.emAndamento ? 0xf59e0b : (cheio ? 0xef4444 : 0x7B2FBE))
    .setTitle(`🎮 ${sala.nome}`)
    .addFields(
      { name: '📊 Status', value: status, inline: true },
      { name: '👥 Vagas', value: `${membrosCount}/${vagas}`, inline: true },
      { name: '⏱️ Criada', value: `<t:${sala.criadoEm}:R>`, inline: true },
      { name: '👤 Criador', value: `<@${sala.criadorId}>`, inline: true },
    )
    .setFooter({ text: cheio ? '🔴 Sala cheia' : '🟢 Aceitando jogadores' });
}

function buildSalaBotoes(salaId, cheio = false, emAndamento = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`entrar_${salaId}`)
      .setLabel('✅ Entrar na Sala')
      .setStyle(ButtonStyle.Success)
      .setDisabled(cheio || emAndamento),
    new ButtonBuilder()
      .setCustomId(`sair_${salaId}`)
      .setLabel('🚪 Sair da Sala')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(emAndamento),
  );
}

function buildPrivadoEmbed(sala) {
  return new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle(`🎮 ${sala.nome} — Canal Privado`)
    .setDescription('Bem-vindo à sala! O código do lobby está abaixo.')
    .addFields(
      { name: '🔑 Código do Lobby', value: `\`\`\`${sala.codigo}\`\`\``, inline: false },
      { name: '👥 Participantes', value: `${sala.membros.size}/${sala.vagas}`, inline: true },
      { name: '👤 Criador', value: `<@${sala.criadorId}>`, inline: true },
    )
    .setFooter({ text: 'Boa partida! 🏆' });
}

function buildPrivadoBotoes(salaId, userId, criadorId, emAndamento) {
  const row1 = new ActionRowBuilder();
  const row2 = new ActionRowBuilder();

  // Primeira linha - botões comuns
  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(`partida_acabou_${salaId}`)
      .setLabel('🏁 Partida Acabou')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sair_privado_${salaId}`)
      .setLabel('🚪 Sair da Sala')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(emAndamento),
  );

  // Segunda linha - botões exclusivos do criador
  if (userId === criadorId) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`toggle_andamento_${salaId}`)
        .setLabel(emAndamento ? '⏸️ Pausar Partida' : '▶️ Iniciar Partida')
        .setStyle(emAndamento ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`encerrar_partida_${salaId}`)
        .setLabel('🏁 Encerrar Partida')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`forcar_fechar_${salaId}`)
        .setLabel('🗑️ Fechar Sala')
        .setStyle(ButtonStyle.Danger),
    );
    return [row1, row2];
  }

  return [row1];
}

function buildVotacaoEmbed(sala) {
  const v = sala.votacao;
  const total = v.sim.size + v.nao.size;
  const precisam = Math.max(MIN_VOTES, Math.ceil(sala.membros.size / 2));
  const faltam = Math.max(0, precisam - v.sim.size);

  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('⚔️ Votação — A partida acabou?')
    .addFields(
      { name: '✅ Sim', value: `${v.sim.size} votos`, inline: true },
      { name: '❌ Não', value: `${v.nao.size} votos`, inline: true },
      { name: '📊 Total', value: `${total} votos`, inline: true },
      { name: '⚠️ Para fechar', value: faltam > 0 ? `Faltam **${faltam}** votos em Sim` : '✅ Votos suficientes!', inline: false },
    )
    .setFooter({ text: `Mínimo: ${precisam} votos em Sim | O criador pode forçar fechar a qualquer momento` });
}

function buildVotacaoBotoes(salaId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`votar_sim_${salaId}`)
      .setLabel('✅ Sim, acabou')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`votar_nao_${salaId}`)
      .setLabel('❌ Não acabou')
      .setStyle(ButtonStyle.Danger),
  );
}

// ─────────────────────────────────────────────
//  FECHAR SALA
// ─────────────────────────────────────────────
async function fecharSala(salaId, guild, motivo = 'votação') {
  const sala = salas.get(salaId);
  if (!sala) return;

  try {
    // Deleta canais privados
    const textCh = guild.channels.cache.get(sala.textChannelId);
    const voiceCh = guild.channels.cache.get(sala.voiceChannelId);
    if (textCh) await textCh.delete();
    if (voiceCh) await voiceCh.delete();

    // Remove embed do canal de salas
    const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
    if (salasCh) {
      const msg = await salasCh.messages.fetch(sala.embedMessageId).catch(() => null);
      if (msg) await msg.delete();
    }

    await log(guild, `🗑️ Sala **${sala.nome}** fechada por ${motivo}. Criador: <@${sala.criadorId}> | Participantes: ${sala.membros.size}`);
  } catch (e) {
    console.error('Erro ao fechar sala:', e);
  }

  salas.delete(salaId);

  // Atualiza painel de admin
  await atualizarPainelAdmin(guild);
}

// ─────────────────────────────────────────────
//  PAINEL DE ADMINISTRAÇÃO
// ─────────────────────────────────────────────
async function atualizarPainelAdmin(guild) {
  if (!ADMIN_SALAS_CHANNEL_ID) return;

  try {
    const adminCh = guild.channels.cache.get(ADMIN_SALAS_CHANNEL_ID);
    if (!adminCh) return;

    const msgs = await adminCh.messages.fetch({ limit: 10 });
    const painelMsg = msgs.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title?.includes('Painel de Administração'));

    if (!painelMsg) return;

    const embed = buildAdminPainelEmbed();
    const components = buildAdminPainelBotoes();

    await painelMsg.edit({ embeds: [embed], components });
  } catch (e) {
    console.error('Erro ao atualizar painel admin:', e);
  }
}

function buildAdminPainelEmbed() {
  const salasArray = Array.from(salas.values());

  const embed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('🛡️ Painel de Administração — Salas Ativas')
    .setDescription(salasArray.length === 0
      ? '📭 Nenhuma sala ativa no momento.'
      : `🎮 **${salasArray.length} sala(s) ativa(s)**\n\nUse o menu abaixo para gerenciar as salas.`)
    .setFooter({ text: `Última atualização: ${new Date().toLocaleTimeString('pt-BR')}` });

  if (salasArray.length > 0) {
    const salasInfo = salasArray.map((s, i) => {
      const status = s.emAndamento ? '🔴' : '🟢';
      return `**${i + 1}.** ${status} **${s.nome}**\n   └ Criador: <@${s.criadorId}> | Jogadores: ${s.membros.size}/${s.vagas} | ID: \`${s.id}\``;
    }).join('\n\n');

    embed.addFields({ name: '📋 Salas Ativas', value: salasInfo });
  }

  return embed;
}

function buildAdminPainelBotoes() {
  const salasArray = Array.from(salas.values());
  const components = [];

  // Select menu para escolher sala
  if (salasArray.length > 0) {
    const options = salasArray.slice(0, 25).map(s => ({
      label: `${s.nome} (${s.membros.size}/${s.vagas})`,
      description: `Criador: ${s.criadorId} | Status: ${s.emAndamento ? 'Em andamento' : 'Esperando'}`,
      value: s.id,
      emoji: s.emAndamento ? '🔴' : '🟢',
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('admin_select_sala')
      .setPlaceholder('Selecione uma sala para deletar')
      .addOptions(options);

    components.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  // Botão de refresh
  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('admin_refresh')
      .setLabel('🔄 Atualizar Lista')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('admin_delete_all')
      .setLabel('🗑️ Fechar Todas as Salas')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(salasArray.length === 0),
  );
  components.push(refreshRow);

  return components;
}

// ─────────────────────────────────────────────
//  ATUALIZAR EMBED PÚBLICO DA SALA
// ─────────────────────────────────────────────
async function atualizarEmbedPublico(salaId, guild) {
  const sala = salas.get(salaId);
  if (!sala) return;
  try {
    const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
    const msg = await salasCh.messages.fetch(sala.embedMessageId);
    const cheio = sala.membros.size >= sala.vagas;
    await msg.edit({ embeds: [buildSalaEmbed(sala)], components: [buildSalaBotoes(salaId, cheio, sala.emAndamento)] });
  } catch {}
}

// ─────────────────────────────────────────────
//  BOT PRONTO
// ─────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Custom Game Bot online: ${client.user.tag}`);

  // Manda (ou atualiza) a mensagem do botão "Criar Sala" no canal #salas
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return console.error('❌ Servidor não encontrado!');

  const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
  if (!salasCh) return console.error('❌ Canal de salas não encontrado!');

  // Limpa mensagens antigas do bot no canal
  const msgs = await salasCh.messages.fetch({ limit: 20 });
  for (const [, m] of msgs) {
    if (m.author.id === client.user.id && m.components.length > 0) {
      const hasCreate = m.components[0]?.components?.some(c => c.customId === 'criar_sala');
      if (hasCreate) await m.delete().catch(() => {});
    }
  }

  const criarEmbed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('🎮 Custom Game — Salas Ativas')
    .setDescription('Clique no botão abaixo para criar uma sala de custom game.\nAs salas ativas aparecerão aqui em tempo real.\n\n*Apenas membros com cargo 🎮 Jogador ou superior podem criar salas.*')
    .setFooter({ text: 'Arkheron SA • Custom Game' });

  const criarRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('criar_sala')
      .setLabel('🎮 Criar Sala')
      .setStyle(ButtonStyle.Primary),
  );

  await salasCh.send({ embeds: [criarEmbed], components: [criarRow] });
  console.log('✅ Painel de salas enviado!');

  // Envia painel de administração (se existir o canal)
  if (ADMIN_SALAS_CHANNEL_ID) {
    const adminCh = guild.channels.cache.get(ADMIN_SALAS_CHANNEL_ID);
    if (adminCh) {
      // Limpa mensagens antigas do painel admin
      const adminMsgs = await adminCh.messages.fetch({ limit: 20 });
      for (const [, m] of adminMsgs) {
        if (m.author.id === client.user.id) {
          await m.delete().catch(() => {});
        }
      }

      const adminEmbed = buildAdminPainelEmbed();
      const adminComponents = buildAdminPainelBotoes();

      await adminCh.send({ embeds: [adminEmbed], components: adminComponents });
      console.log('✅ Painel de administração enviado!');
    }
  }
});

// ─────────────────────────────────────────────
//  INTERAÇÕES
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    const guild = interaction.guild;

  // ── BOTÃO: Criar Sala ──
  if (interaction.isButton() && interaction.customId === 'criar_sala') {
    // Verifica cargo mínimo
    const member = interaction.member;
    const temCargo = member.roles.cache.has(MIN_ROLE_ID) ||
      member.roles.cache.some(r => ['👑 Dono','⚙️ Admin','🛡️ Moderador','🔧 Helper','⭐ Veterano','🔥 Ativo'].includes(r.name));

    if (!temCargo) {
      return interaction.reply({
        content: '❌ Você precisa ter o cargo **🎮 Jogador** ou superior para criar uma sala!',
        ephemeral: true,
      });
    }

    // Verifica se já tem sala ativa
    const jaTemSala = [...salas.values()].some(s => s.criadorId === interaction.user.id);
    if (jaTemSala) {
      return interaction.reply({
        content: '❌ Você já tem uma sala ativa! Feche a sala atual antes de criar uma nova.',
        ephemeral: true,
      });
    }

    // Abre modal
    const modal = new ModalBuilder()
      .setCustomId('modal_criar_sala')
      .setTitle('🎮 Criar Sala de Custom Game');

    const nomeInput = new TextInputBuilder()
      .setCustomId('sala_nome')
      .setLabel('Nome da sala')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Ex: Casual iniciantes, Ranked veteranos...')
      .setMaxLength(50)
      .setRequired(true);

    const codigoInput = new TextInputBuilder()
      .setCustomId('sala_codigo')
      .setLabel('Código do lobby')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Ex: XKZT99')
      .setMaxLength(20)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nomeInput),
      new ActionRowBuilder().addComponents(codigoInput),
    );

    return interaction.showModal(modal);
  }

  // ── MODAL: Criar Sala ──
  if (interaction.isModalSubmit() && interaction.customId === 'modal_criar_sala') {
    await interaction.deferReply({ ephemeral: true });

    const nome   = interaction.fields.getTextInputValue('sala_nome');
    const codigo = interaction.fields.getTextInputValue('sala_codigo');
    const vagasRaw = 60; // Sempre 60 jogadores

    const salaId = gerarId();
    const criadorId = interaction.user.id;

    // Cria categoria (se não tiver)
    const categoria = guild.channels.cache.get(CUSTOM_CATEGORY_ID);
    if (!categoria) return interaction.editReply({ content: '❌ Categoria de salas não encontrada! Configure o CUSTOM_CATEGORY_ID no .env' });

    // Permissões base — canal invisível para @everyone
    const permBase = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      { id: criadorId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];

    // Cria canal de texto privado
    const textChannel = await guild.channels.create({
      name: `🎮・${nome.toLowerCase().replace(/\s+/g, '-').substring(0, 30)}`,
      type: ChannelType.GuildText,
      parent: categoria.id,
      permissionOverwrites: permBase,
      topic: `Sala de custom game | Criador: ${interaction.user.username} | Código: ${codigo}`,
    });

    // Cria canal de voz privado
    const voiceChannel = await guild.channels.create({
      name: `🎮 ${nome.substring(0, 30)}`,
      type: ChannelType.GuildVoice,
      parent: categoria.id,
      userLimit: vagasRaw,
      permissionOverwrites: permBase,
    });

    // Registra a sala
    const sala = {
      id: salaId,
      nome,
      codigo,
      vagas: vagasRaw,
      criadorId,
      membros: new Set([criadorId]),
      embedMessageId: null,
      textChannelId: textChannel.id,
      voiceChannelId: voiceChannel.id,
      criadoEm: Math.floor(Date.now() / 1000),
      votacao: { ativa: false, sim: new Set(), nao: new Set(), messageId: null },
      emAndamento: false, // Inicia esperando jogadores
    };
    salas.set(salaId, sala);

    // Posta embed público no canal #salas
    const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
    const embedMsg = await salasCh.send({
      embeds: [buildSalaEmbed(sala)],
      components: [buildSalaBotoes(salaId, false, sala.emAndamento)],
    });
    sala.embedMessageId = embedMsg.id;

    // Posta embed privado no canal da sala
    const privMsg = await textChannel.send({
      content: `<@${criadorId}>`,
      embeds: [buildPrivadoEmbed(sala)],
      components: buildPrivadoBotoes(salaId, criadorId, criadorId, sala.emAndamento),
    });
    await privMsg.pin();

    await log(guild, `🎮 Sala **${nome}** criada por <@${criadorId}> | Vagas: ${vagasRaw} | ID: ${salaId}`);
    await interaction.editReply({ content: `✅ Sala **${nome}** criada! Acesse: ${textChannel}` });
    return;
  }

  // ── BOTÃO: Entrar na Sala ──
  if (interaction.isButton() && interaction.customId.startsWith('entrar_')) {
    const salaId = interaction.customId.replace('entrar_', '');
    const sala = salas.get(salaId);

    if (!sala) return interaction.reply({ content: '❌ Sala não encontrada ou já foi fechada.', ephemeral: true });
    if (sala.emAndamento) return interaction.reply({ content: '❌ A partida já está em andamento! Não é possível entrar agora.', ephemeral: true });
    if (sala.membros.size >= sala.vagas) return interaction.reply({ content: '❌ Sala cheia!', ephemeral: true });
    if (sala.membros.has(interaction.user.id)) return interaction.reply({ content: '❌ Você já está nessa sala!', ephemeral: true });

    // Adiciona membro
    sala.membros.add(interaction.user.id);

    // Libera acesso ao canal privado
    const textCh = guild.channels.cache.get(sala.textChannelId);
    const voiceCh = guild.channels.cache.get(sala.voiceChannelId);
    await textCh.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
    await voiceCh.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, Connect: true });

    // Atualiza embed público
    await atualizarEmbedPublico(salaId, guild);

    // Atualiza embed privado (sempre passa o criador como userId para manter os botões dele)
    const msgs = await textCh.messages.fetch({ limit: 10 });
    const pinned = msgs.find(m => m.author.id === client.user.id && m.pinned);
    if (pinned) {
      await pinned.edit({
        embeds: [buildPrivadoEmbed(sala)],
        components: buildPrivadoBotoes(salaId, sala.criadorId, sala.criadorId, sala.emAndamento),
      });
    }

    // Avisa no canal privado
    await textCh.send(`✅ <@${interaction.user.id}> entrou na sala! (${sala.membros.size}/${sala.vagas})`);

    await interaction.reply({ content: `✅ Você entrou! Acesse: ${textCh}`, ephemeral: true });
    return;
  }

  // ── BOTÃO: Sair da Sala (público) ──
  if (interaction.isButton() && interaction.customId.startsWith('sair_') && !interaction.customId.startsWith('sair_privado_')) {
    const salaId = interaction.customId.replace('sair_', '');
    const sala = salas.get(salaId);

    if (!sala) return interaction.reply({ content: '❌ Sala não encontrada.', ephemeral: true });
    if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '❌ Você não está nessa sala.', ephemeral: true });

    await interaction.reply({ content: '✅ Você saiu da sala.', ephemeral: true });
    await removerMembro(salaId, interaction.user.id, guild);
    return;
  }

  // ── BOTÃO: Sair da Sala (privado) ──
  if (interaction.isButton() && interaction.customId.startsWith('sair_privado_')) {
    const salaId = interaction.customId.replace('sair_privado_', '');
    const sala = salas.get(salaId);

    if (!sala) return interaction.reply({ content: '❌ Sala não encontrada.', ephemeral: true });
    if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '❌ Você não está nessa sala.', ephemeral: true });

    await interaction.reply({ content: '✅ Você saiu da sala.', ephemeral: true });
    await removerMembro(salaId, interaction.user.id, guild);
    return;
  }

  // ── BOTÃO: Partida Acabou ──
  if (interaction.isButton() && interaction.customId.startsWith('partida_acabou_')) {
    const salaId = interaction.customId.replace('partida_acabou_', '');
    const sala = salas.get(salaId);

    if (!sala) return interaction.reply({ content: '❌ Sala não encontrada.', ephemeral: true });
    if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '❌ Você não está nessa sala.', ephemeral: true });
    if (sala.votacao.ativa) return interaction.reply({ content: '❌ Já tem uma votação em andamento!', ephemeral: true });

    // Inicia votação
    sala.votacao = { ativa: true, sim: new Set(), nao: new Set(), messageId: null };

    const textCh = guild.channels.cache.get(sala.textChannelId);
    const votMsg = await textCh.send({
      content: '@here 🗳️ Votação iniciada!',
      embeds: [buildVotacaoEmbed(sala)],
      components: [buildVotacaoBotoes(salaId)],
    });
    sala.votacao.messageId = votMsg.id;

    await interaction.reply({ content: '✅ Votação iniciada!', ephemeral: true });
    return;
  }

  // ── BOTÃO: Votar Sim ──
  if (interaction.isButton() && interaction.customId.startsWith('votar_sim_')) {
    const salaId = interaction.customId.replace('votar_sim_', '');
    const sala = salas.get(salaId);

    if (!sala || !sala.votacao.ativa) return interaction.reply({ content: '❌ Votação não encontrada.', ephemeral: true });
    if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '❌ Você não está nessa sala.', ephemeral: true });

    sala.votacao.sim.add(interaction.user.id);
    sala.votacao.nao.delete(interaction.user.id);

    // Atualiza embed da votação
    const textCh = guild.channels.cache.get(sala.textChannelId);
    const votMsg = await textCh.messages.fetch(sala.votacao.messageId);
    await votMsg.edit({ embeds: [buildVotacaoEmbed(sala)], components: [buildVotacaoBotoes(salaId)] });

    // Verifica se atingiu o mínimo
    const precisam = Math.max(MIN_VOTES, Math.ceil(sala.membros.size / 2));
    if (sala.votacao.sim.size >= precisam) {
      await votMsg.edit({ content: '✅ Votos suficientes! 🏁 **A partida acabou!** A sala será fechada em **10 segundos**...', components: [] });
      await interaction.reply({ content: '✅ Votação encerrada! A sala será fechada em 10 segundos.', ephemeral: true });
      const textCh = guild.channels.cache.get(sala.textChannelId);
      await textCh.send('🏁 **A partida acabou!** A sala será fechada em **10 segundos**...');
      await sleep(10000);
      await fecharSala(salaId, guild, 'votação (maioria atingida)');
      return;
    }

    await interaction.reply({ content: '✅ Voto registrado!', ephemeral: true });
    return;
  }

  // ── BOTÃO: Votar Não ──
  if (interaction.isButton() && interaction.customId.startsWith('votar_nao_')) {
    const salaId = interaction.customId.replace('votar_nao_', '');
    const sala = salas.get(salaId);

    if (!sala || !sala.votacao.ativa) return interaction.reply({ content: '❌ Votação não encontrada.', ephemeral: true });
    if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '❌ Você não está nessa sala.', ephemeral: true });

    sala.votacao.nao.add(interaction.user.id);
    sala.votacao.sim.delete(interaction.user.id);

    const textCh = guild.channels.cache.get(sala.textChannelId);
    const votMsg = await textCh.messages.fetch(sala.votacao.messageId);
    await votMsg.edit({ embeds: [buildVotacaoEmbed(sala)], components: [buildVotacaoBotoes(salaId)] });

    await interaction.reply({ content: '✅ Voto registrado!', ephemeral: true });
    return;
  }

  // ── BOTÃO: Toggle Partida em Andamento (criador) ──
  if (interaction.isButton() && interaction.customId.startsWith('toggle_andamento_')) {
    const salaId = interaction.customId.replace('toggle_andamento_', '');
    const sala = salas.get(salaId);

    if (!sala) return interaction.reply({ content: '❌ Sala não encontrada.', ephemeral: true });
    if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '❌ Apenas o criador pode alterar o status da partida.', ephemeral: true });

    // Alterna o status
    sala.emAndamento = !sala.emAndamento;
    const novoStatus = sala.emAndamento ? '🔴 Partida iniciada!' : '🟢 Partida pausada!';

    // Atualiza embed público
    await atualizarEmbedPublico(salaId, guild);

    // Atualiza embed privado (sempre passa o criador para manter os botões)
    const textCh = guild.channels.cache.get(sala.textChannelId);
    const msgs = await textCh.messages.fetch({ limit: 10 });
    const pinned = msgs.find(m => m.author.id === client.user.id && m.pinned);
    if (pinned) {
      await pinned.edit({
        embeds: [buildPrivadoEmbed(sala)],
        components: buildPrivadoBotoes(salaId, sala.criadorId, sala.criadorId, sala.emAndamento),
      });
    }

    await textCh.send(`${novoStatus} Status alterado por <@${interaction.user.id}>`);
    await interaction.reply({ content: `✅ ${novoStatus}`, ephemeral: true });
    return;
  }

  // ── BOTÃO: Encerrar Partida (criador) ──
  if (interaction.isButton() && interaction.customId.startsWith('encerrar_partida_')) {
    const salaId = interaction.customId.replace('encerrar_partida_', '');
    const sala = salas.get(salaId);

    if (!sala) return interaction.reply({ content: '❌ Sala não encontrada.', ephemeral: true });
    if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '❌ Apenas o criador pode encerrar a partida.', ephemeral: true });

    const textCh = guild.channels.cache.get(sala.textChannelId);
    await textCh.send('🏁 **O líder encerrou a partida!** A sala será fechada em **10 segundos**...');
    await interaction.reply({ content: '🏁 Encerrando partida em 10 segundos...', ephemeral: true });
    await sleep(10000);
    await fecharSala(salaId, guild, `encerrada pelo líder (<@${interaction.user.id}>)`);
    return;
  }

  // ── BOTÃO: Forçar Fechar (criador) ──
  if (interaction.isButton() && interaction.customId.startsWith('forcar_fechar_')) {
    const salaId = interaction.customId.replace('forcar_fechar_', '');
    const sala = salas.get(salaId);

    if (!sala) return interaction.reply({ content: '❌ Sala não encontrada.', ephemeral: true });
    if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '❌ Apenas o criador pode forçar o fechamento.', ephemeral: true });

    const textCh = guild.channels.cache.get(sala.textChannelId);
    await textCh.send('🏁 **A partida acabou!** A sala será fechada em **10 segundos**...');
    await interaction.reply({ content: '🗑️ Fechando sala em 10 segundos...', ephemeral: true });
    await sleep(10000);
    await fecharSala(salaId, guild, `criador (<@${interaction.user.id}>)`);
    return;
  }

  // ── ADMIN: Refresh Painel ──
  if (interaction.isButton() && interaction.customId === 'admin_refresh') {
    // Verifica se é admin
    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(r => ['👑 Dono','⚙️ Admin','🛡️ Moderador'].includes(r.name));

    if (!isAdmin) {
      return interaction.reply({ content: '❌ Você não tem permissão para usar este painel!', ephemeral: true });
    }

    await atualizarPainelAdmin(guild);
    await interaction.reply({ content: '✅ Painel atualizado!', ephemeral: true });
    return;
  }

  // ── ADMIN: Deletar Todas as Salas ──
  if (interaction.isButton() && interaction.customId === 'admin_delete_all') {
    // Verifica se é admin
    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(r => ['👑 Dono','⚙️ Admin'].includes(r.name));

    if (!isAdmin) {
      return interaction.reply({ content: '❌ Você não tem permissão para usar esta ação!', ephemeral: true });
    }

    const salasArray = Array.from(salas.keys());
    if (salasArray.length === 0) {
      return interaction.reply({ content: '❌ Não há salas ativas para fechar!', ephemeral: true });
    }

    await interaction.reply({ content: `🗑️ Fechando ${salasArray.length} sala(s)...`, ephemeral: true });

    for (const salaId of salasArray) {
      const sala = salas.get(salaId);
      if (sala) {
        const textCh = guild.channels.cache.get(sala.textChannelId);
        if (textCh) await textCh.send('🛡️ **Sala fechada por um administrador.**');
        await fecharSala(salaId, guild, `administrador (<@${interaction.user.id}>)`);
      }
    }

    await interaction.followUp({ content: `✅ ${salasArray.length} sala(s) fechada(s) com sucesso!`, ephemeral: true });
    return;
  }

  // ── ADMIN: Select Menu - Deletar Sala Específica ──
  if (interaction.isStringSelectMenu() && interaction.customId === 'admin_select_sala') {
    // Verifica se é admin
    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(r => ['👑 Dono','⚙️ Admin','🛡️ Moderador'].includes(r.name));

    if (!isAdmin) {
      return interaction.reply({ content: '❌ Você não tem permissão para usar este painel!', ephemeral: true });
    }

    const salaId = interaction.values[0];
    const sala = salas.get(salaId);

    if (!sala) {
      return interaction.reply({ content: '❌ Sala não encontrada ou já foi fechada!', ephemeral: true });
    }

    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (textCh) await textCh.send(`🛡️ **Sala fechada por um administrador** (<@${interaction.user.id}>).`);

    await interaction.reply({ content: `🗑️ Fechando sala **${sala.nome}**...`, ephemeral: true });
    await fecharSala(salaId, guild, `administrador (<@${interaction.user.id}>)`);

    await interaction.followUp({ content: `✅ Sala **${sala.nome}** fechada com sucesso!`, ephemeral: true });
    return;
  }

  } catch (error) {
    console.error(`Erro ao processar interação ${interaction?.customId || interaction?.commandName || 'desconhecida'}:`, error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Ocorreu um erro interno ao processar sua ação. Tente novamente.', ephemeral: true });
      } else {
        await interaction.followUp({ content: '❌ Ocorreu um erro interno ao processar sua ação. Tente novamente.', ephemeral: true });
      }
    } catch (e) {
      // Falhou ao tentar responder o erro
    }
  }
});

// ─────────────────────────────────────────────
//  REMOVER MEMBRO DA SALA
// ─────────────────────────────────────────────
async function removerMembro(salaId, userId, guild) {
  const sala = salas.get(salaId);
  if (!sala) return;

  sala.membros.delete(userId);
  sala.votacao.sim.delete(userId);
  sala.votacao.nao.delete(userId);

  // Remove acesso ao canal privado
  const textCh = guild.channels.cache.get(sala.textChannelId);
  const voiceCh = guild.channels.cache.get(sala.voiceChannelId);
  if (textCh) await textCh.permissionOverwrites.delete(userId).catch(() => {});
  if (voiceCh) await voiceCh.permissionOverwrites.delete(userId).catch(() => {});

  // Se o criador saiu, fecha a sala
  if (userId === sala.criadorId) {
    if (textCh) await textCh.send('👤 O criador saiu. A sala será fechada automaticamente...');
    await sleep(2000);
    await fecharSala(salaId, guild, 'criador saiu');
    return;
  }

  // Atualiza embeds
  await atualizarEmbedPublico(salaId, guild);
  if (textCh) await textCh.send(`🚪 <@${userId}> saiu da sala. (${sala.membros.size}/${sala.vagas})`);
}

// ─────────────────────────────────────────────
//  LOGIN
// ─────────────────────────────────────────────
client.login(DISCORD_TOKEN).catch(err => {
  console.error('❌ Token inválido:', err.message);
  process.exit(1);
});

// Eventos de falha globais para evitar que o bot feche
client.on('error', (error) => {
  console.error('Discord Client Error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
