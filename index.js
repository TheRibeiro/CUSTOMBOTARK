// ================================================================
//  ARKHERON SA — Custom Game Bot v2.0
//  Reescrito com: persistencia de estado, cleanup de orfaos,
//  votacao com timeout, graceful shutdown, modo debug,
//  logging estruturado (winston), protecao contra race conditions
// ================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  ChannelType, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} = require('discord.js');
const winston = require('winston');

// ─────────────────────────────────────────────
//  LOGGER (winston)
// ─────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console({ colorize: true }),
    new winston.transports.File({
      filename: path.join(__dirname, 'logs', 'bot.log'),
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, 'logs', 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

// Cria pasta de logs se nao existe
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ─────────────────────────────────────────────
//  CLIENT
// ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ]
});

// ─────────────────────────────────────────────
//  CONFIGURACOES (env)
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

// ─────────────────────────────────────────────
//  MODO DEBUG (teste solo)
// ─────────────────────────────────────────────
const DEBUG = process.env.DEBUG_MODE === 'true';
const SKIP_ROLE_CHECK = DEBUG && process.env.DEBUG_SKIP_ROLE_CHECK === 'true';
const VOTE_TIMEOUT_MS = parseInt(process.env.VOTE_TIMEOUT_MS || '180000');   // 3 min
const CLOSE_DELAY_SEC = DEBUG ? 3 : 10;
const MAX_SALAS = parseInt(process.env.MAX_SALAS || '20');
const MAX_ROOM_AGE_H = parseInt(process.env.MAX_ROOM_AGE_H || '6');         // 6 horas

if (DEBUG) {
  logger.warn('>>> MODO DEBUG ATIVO — Nao use em producao! <<<');
  logger.info(`  SKIP_ROLE_CHECK=${SKIP_ROLE_CHECK}`);
  logger.info(`  VOTE_TIMEOUT=${VOTE_TIMEOUT_MS}ms | CLOSE_DELAY=${CLOSE_DELAY_SEC}s`);
}

// ─────────────────────────────────────────────
//  PERSISTENCIA DE ESTADO (JSON)
// ─────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function salvarEstado() {
  try {
    const data = {};
    for (const [id, sala] of salas) {
      data[id] = {
        id: sala.id,
        nome: sala.nome,
        codigo: sala.codigo,
        vagas: sala.vagas,
        criadorId: sala.criadorId,
        membros: Array.from(sala.membros),
        embedMessageId: sala.embedMessageId,
        textChannelId: sala.textChannelId,
        privadoMessageId: sala.privadoMessageId,
        criadoEm: sala.criadoEm,
        emAndamento: sala.emAndamento,
        votacao: {
          ativa: sala.votacao.ativa,
          sim: Array.from(sala.votacao.sim),
          nao: Array.from(sala.votacao.nao),
          messageId: sala.votacao.messageId,
          iniciadaEm: sala.votacao.iniciadaEm || null,
        },
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ salas: data, savedAt: Date.now() }, null, 2));
    logger.debug(`Estado salvo: ${salas.size} sala(s)`);
  } catch (e) {
    logger.error(`Erro ao salvar estado: ${e.message}`);
  }
}

function carregarEstado() {
  try {
    if (!fs.existsSync(STATE_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const loaded = new Map();
    for (const [id, sala] of Object.entries(raw.salas || {})) {
      loaded.set(id, {
        ...sala,
        membros: new Set(sala.membros),
        votacao: {
          ativa: sala.votacao.ativa,
          sim: new Set(sala.votacao.sim),
          nao: new Set(sala.votacao.nao),
          messageId: sala.votacao.messageId,
          iniciadaEm: sala.votacao.iniciadaEm || null,
        },
        fechando: false,
      });
    }
    logger.info(`Estado carregado: ${loaded.size} sala(s) do arquivo`);
    return loaded;
  } catch (e) {
    logger.warn(`Nao foi possivel carregar estado: ${e.message}`);
    return new Map();
  }
}

// ─────────────────────────────────────────────
//  MEMORIA DE SALAS ATIVAS
// ─────────────────────────────────────────────
const salas = new Map();          // salaId -> sala
const voteTimeouts = new Map();   // salaId -> setTimeout handle

// ─────────────────────────────────────────────
//  FUNCOES AUXILIARES
// ─────────────────────────────────────────────
function gerarId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function logDiscord(guild, msg) {
  try {
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) await logChannel.send(`\`[${new Date().toLocaleTimeString('pt-BR')}]\` ${msg}`);
  } catch (e) {
    logger.warn(`Erro ao enviar log para Discord: ${e.message}`);
  }
}

function calcularVotosNecessarios(totalMembros) {
  if (DEBUG) return parseInt(process.env.DEBUG_MIN_VOTES || '1');
  // 60% dos membros, minimo de 2
  return Math.max(2, Math.ceil(totalMembros * 0.6));
}

function temCargoMinimo(member) {
  if (SKIP_ROLE_CHECK) return true;
  return member.roles.cache.has(MIN_ROLE_ID) ||
    member.roles.cache.some(r =>
      ['\uD83D\uDC51 Dono', '\u2699\uFE0F Admin', '\uD83D\uDEE1\uFE0F Moderador', '\uD83D\uDD27 Helper', '\u2B50 Veterano', '\uD83D\uDD25 Ativo'].includes(r.name)
    );
}

function ehAdmin(member) {
  if (SKIP_ROLE_CHECK) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some(r =>
      ['\uD83D\uDC51 Dono', '\u2699\uFE0F Admin', '\uD83D\uDEE1\uFE0F Moderador'].includes(r.name)
    );
}

// ─────────────────────────────────────────────
//  BUILDERS — Embeds e Botoes
// ─────────────────────────────────────────────
function buildSalaEmbed(sala) {
  const membrosCount = sala.membros.size;
  const cheio = membrosCount >= sala.vagas;
  const status = sala.fechando
    ? '\uD83D\uDFE1 Fechando...'
    : sala.emAndamento
      ? '\uD83D\uDD34 Partida em andamento'
      : '\uD83D\uDFE2 Esperando jogadores';

  return new EmbedBuilder()
    .setColor(sala.fechando ? 0xfbbf24 : sala.emAndamento ? 0xf59e0b : (cheio ? 0xef4444 : 0x7B2FBE))
    .setTitle(`\uD83C\uDFAE ${sala.nome}`)
    .addFields(
      { name: '\uD83D\uDCCA Status', value: status, inline: true },
      { name: '\uD83D\uDC65 Vagas', value: `${membrosCount}/${sala.vagas}`, inline: true },
      { name: '\u23F1\uFE0F Criada', value: `<t:${sala.criadoEm}:R>`, inline: true },
      { name: '\uD83D\uDC64 Criador', value: `<@${sala.criadorId}>`, inline: true },
    )
    .setFooter({ text: cheio ? '\uD83D\uDD34 Sala cheia' : '\uD83D\uDFE2 Aceitando jogadores' });
}

function buildSalaBotoes(salaId, cheio = false, emAndamento = false, fechando = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`entrar_${salaId}`)
      .setLabel('\u2705 Entrar na Sala')
      .setStyle(ButtonStyle.Success)
      .setDisabled(cheio || emAndamento || fechando),
    new ButtonBuilder()
      .setCustomId(`sair_${salaId}`)
      .setLabel('\uD83D\uDEAA Sair da Sala')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(emAndamento || fechando),
  );
}

function buildPrivadoEmbed(sala) {
  return new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle(`\uD83C\uDFAE ${sala.nome} — Canal Privado`)
    .setDescription('Bem-vindo a sala! O codigo do lobby esta abaixo.')
    .addFields(
      { name: '\uD83D\uDD11 Codigo do Lobby', value: `\`\`\`${sala.codigo}\`\`\``, inline: false },
      { name: '\uD83D\uDC65 Participantes', value: `${sala.membros.size}/${sala.vagas}`, inline: true },
      { name: '\uD83D\uDC64 Criador', value: `<@${sala.criadorId}>`, inline: true },
    )
    .setFooter({ text: 'Boa partida!' });
}

function buildPrivadoBotoes(salaId, criadorId, emAndamento) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`partida_acabou_${salaId}`)
      .setLabel('\uD83C\uDFC1 Partida Acabou')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sair_privado_${salaId}`)
      .setLabel('\uD83D\uDEAA Sair da Sala')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(emAndamento),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`toggle_andamento_${salaId}`)
      .setLabel(emAndamento ? '\u23F8\uFE0F Pausar Partida' : '\u25B6\uFE0F Iniciar Partida')
      .setStyle(emAndamento ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`encerrar_partida_${salaId}`)
      .setLabel('\uD83C\uDFC1 Encerrar Partida')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`forcar_fechar_${salaId}`)
      .setLabel('\uD83D\uDDD1\uFE0F Fechar Sala')
      .setStyle(ButtonStyle.Danger),
  );

  // row2 so aparece para o criador (validacao no handler)
  return [row1, row2];
}

function buildVotacaoEmbed(sala) {
  const v = sala.votacao;
  const total = v.sim.size + v.nao.size;
  const precisam = calcularVotosNecessarios(sala.membros.size);
  const faltam = Math.max(0, precisam - v.sim.size);

  const tempoRestante = v.iniciadaEm
    ? Math.max(0, Math.ceil((v.iniciadaEm + VOTE_TIMEOUT_MS - Date.now()) / 1000))
    : 0;

  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('\u2694\uFE0F Votacao — A partida acabou?')
    .addFields(
      { name: '\u2705 Sim', value: `${v.sim.size} votos`, inline: true },
      { name: '\u274C Nao', value: `${v.nao.size} votos`, inline: true },
      { name: '\uD83D\uDCCA Total', value: `${total} votos`, inline: true },
      {
        name: '\u26A0\uFE0F Para fechar',
        value: faltam > 0
          ? `Faltam **${faltam}** votos em Sim`
          : '\u2705 Votos suficientes!',
        inline: false,
      },
    )
    .setFooter({
      text: `Minimo: ${precisam} votos Sim | Expira em ${Math.floor(tempoRestante / 60)}m${tempoRestante % 60}s | Criador pode forcar fechar`,
    });

  return embed;
}

function buildVotacaoBotoes(salaId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`votar_sim_${salaId}`)
      .setLabel('\u2705 Sim, acabou')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`votar_nao_${salaId}`)
      .setLabel('\u274C Nao acabou')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`votar_cancelar_${salaId}`)
      .setLabel('\u23F9\uFE0F Cancelar Votacao')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─────────────────────────────────────────────
//  GERENCIAMENTO DE SALAS
// ─────────────────────────────────────────────

/**
 * Agenda o fechamento de uma sala com delay.
 * Seta sala.fechando = true ANTES do delay para bloquear interacoes.
 */
async function agendarFechamento(salaId, guild, motivo) {
  const sala = salas.get(salaId);
  if (!sala || sala.fechando) return;

  sala.fechando = true;
  salvarEstado();

  // Cancela votacao se estiver ativa
  cancelarVotacaoTimeout(salaId);

  // Atualiza embed publico para mostrar "Fechando..."
  await atualizarEmbedPublico(salaId, guild);

  const textCh = guild.channels.cache.get(sala.textChannelId);
  if (textCh) {
    await textCh.send(
      `\uD83C\uDFC1 **A sala sera fechada em ${CLOSE_DELAY_SEC} segundos...** (${motivo})`
    ).catch(e => logger.warn(`Erro ao enviar aviso de fechamento: ${e.message}`));
  }

  await sleep(CLOSE_DELAY_SEC * 1000);
  await fecharSala(salaId, guild, motivo);
}

/**
 * Fecha uma sala imediatamente (deleta canal, remove embed, limpa estado).
 */
async function fecharSala(salaId, guild, motivo = 'desconhecido') {
  const sala = salas.get(salaId);
  if (!sala) {
    logger.warn(`Tentativa de fechar sala ${salaId} que nao existe no Map`);
    return;
  }

  logger.info(`Fechando sala ${salaId} (${sala.nome}) — motivo: ${motivo}`);

  try {
    // Deleta canal privado
    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (textCh) {
      await textCh.delete().catch(e => logger.error(`Erro ao deletar canal ${sala.textChannelId}: ${e.message}`));
    }

    // Remove embed do canal de salas
    try {
      const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
      if (salasCh && sala.embedMessageId) {
        const msg = await salasCh.messages.fetch(sala.embedMessageId).catch(() => null);
        if (msg) await msg.delete().catch(e => logger.warn(`Erro ao deletar embed: ${e.message}`));
      }
    } catch (e) {
      logger.warn(`Erro ao limpar embed publico: ${e.message}`);
    }

    await logDiscord(guild, `\uD83D\uDDD1\uFE0F Sala **${sala.nome}** fechada por ${motivo}. Criador: <@${sala.criadorId}> | Participantes: ${sala.membros.size}`);
  } catch (e) {
    logger.error(`Erro ao fechar sala ${salaId}: ${e.message}`);
  }

  // Limpa timers
  cancelarVotacaoTimeout(salaId);

  // Remove do Map e salva
  salas.delete(salaId);
  salvarEstado();

  logger.info(`Sala ${salaId} removida. Salas restantes: ${salas.size}`);

  // Atualiza painel admin
  await atualizarPainelAdmin(guild).catch(e => logger.error(`Erro ao atualizar painel admin: ${e.message}`));
}

/**
 * Remove um membro de uma sala.
 * Se o criador sair, a sala e fechada automaticamente.
 */
async function removerMembro(salaId, userId, guild) {
  const sala = salas.get(salaId);
  if (!sala || sala.fechando) return;

  sala.membros.delete(userId);
  sala.votacao.sim.delete(userId);
  sala.votacao.nao.delete(userId);

  // Remove acesso ao canal privado
  const textCh = guild.channels.cache.get(sala.textChannelId);
  if (textCh) {
    await textCh.permissionOverwrites.delete(userId).catch(e =>
      logger.warn(`Erro ao remover permissao do user ${userId}: ${e.message}`)
    );
  }

  // Se o criador saiu, fecha a sala
  if (userId === sala.criadorId) {
    if (textCh) await textCh.send('\uD83D\uDC64 O criador saiu. A sala sera fechada automaticamente...').catch(() => {});
    await agendarFechamento(salaId, guild, 'criador saiu');
    return;
  }

  // Atualiza embeds
  await atualizarEmbedPublico(salaId, guild);
  await atualizarEmbedPrivado(salaId, guild);
  if (textCh) {
    await textCh.send(`\uD83D\uDEAA <@${userId}> saiu da sala. (${sala.membros.size}/${sala.vagas})`).catch(() => {});
  }
  salvarEstado();
}

// ─────────────────────────────────────────────
//  GERENCIAMENTO DE VOTACAO
// ─────────────────────────────────────────────

function iniciarVotacaoTimeout(salaId, guild) {
  // Cancela timeout anterior se existir
  cancelarVotacaoTimeout(salaId);

  const handle = setTimeout(async () => {
    const sala = salas.get(salaId);
    if (!sala || !sala.votacao.ativa || sala.fechando) return;

    logger.info(`Votacao da sala ${salaId} expirou por timeout`);

    sala.votacao.ativa = false;

    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (textCh && sala.votacao.messageId) {
      try {
        const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
        if (votMsg) {
          await votMsg.edit({
            content: '\u23F0 **Votacao expirou!** Nao houve votos suficientes. Alguem pode iniciar uma nova.',
            embeds: [],
            components: [],
          });
        }
      } catch (e) {
        logger.warn(`Erro ao editar msg de votacao expirada: ${e.message}`);
      }
    }

    sala.votacao = { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null };
    salvarEstado();
    voteTimeouts.delete(salaId);
  }, VOTE_TIMEOUT_MS);

  voteTimeouts.set(salaId, handle);
}

function cancelarVotacaoTimeout(salaId) {
  const handle = voteTimeouts.get(salaId);
  if (handle) {
    clearTimeout(handle);
    voteTimeouts.delete(salaId);
  }
}

// ─────────────────────────────────────────────
//  PAINEL DE ADMINISTRACAO
// ─────────────────────────────────────────────
async function atualizarPainelAdmin(guild) {
  if (!ADMIN_SALAS_CHANNEL_ID) return;

  try {
    const adminCh = guild.channels.cache.get(ADMIN_SALAS_CHANNEL_ID);
    if (!adminCh) return;

    const msgs = await adminCh.messages.fetch({ limit: 10 });
    const painelMsg = msgs.find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      m.embeds[0].title?.includes('Painel de Administra')
    );

    if (!painelMsg) return;

    const embed = buildAdminPainelEmbed();
    const components = buildAdminPainelBotoes();

    await painelMsg.edit({ embeds: [embed], components });
  } catch (e) {
    logger.error(`Erro ao atualizar painel admin: ${e.message}`);
  }
}

function buildAdminPainelEmbed() {
  const salasArray = Array.from(salas.values());

  const embed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('\uD83D\uDEE1\uFE0F Painel de Administracao — Salas Ativas')
    .setDescription(salasArray.length === 0
      ? '\uD83D\uDCED Nenhuma sala ativa no momento.'
      : `\uD83C\uDFAE **${salasArray.length} sala(s) ativa(s)**\n\nUse o menu abaixo para gerenciar as salas.`)
    .setFooter({ text: `Ultima atualizacao: ${new Date().toLocaleTimeString('pt-BR')}` });

  if (salasArray.length > 0) {
    const salasInfo = salasArray.map((s, i) => {
      const status = s.fechando ? '\uD83D\uDFE1' : s.emAndamento ? '\uD83D\uDD34' : '\uD83D\uDFE2';
      return `**${i + 1}.** ${status} **${s.nome}**\n   \u2514 Criador: <@${s.criadorId}> | Jogadores: ${s.membros.size}/${s.vagas} | ID: \`${s.id}\``;
    }).join('\n\n');

    embed.addFields({ name: '\uD83D\uDCCB Salas Ativas', value: salasInfo.substring(0, 1024) });
  }

  return embed;
}

function buildAdminPainelBotoes() {
  const salasArray = Array.from(salas.values());
  const components = [];

  if (salasArray.length > 0) {
    const options = salasArray.slice(0, 25).map(s => ({
      label: `${s.nome} (${s.membros.size}/${s.vagas})`.substring(0, 100),
      description: `Criador: ${s.criadorId} | ${s.emAndamento ? 'Em andamento' : 'Esperando'}`.substring(0, 100),
      value: s.id,
      emoji: s.fechando ? '\uD83D\uDFE1' : s.emAndamento ? '\uD83D\uDD34' : '\uD83D\uDFE2',
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('admin_select_sala')
      .setPlaceholder('Selecione uma sala para deletar')
      .addOptions(options);

    components.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('admin_refresh')
      .setLabel('\uD83D\uDD04 Atualizar Lista')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('admin_delete_all')
      .setLabel('\uD83D\uDDD1\uFE0F Fechar Todas as Salas')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(salasArray.length === 0),
    new ButtonBuilder()
      .setCustomId('admin_cleanup_orfaos')
      .setLabel('\uD83E\uDDF9 Limpar Orfaos')
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(refreshRow);

  return components;
}

// ─────────────────────────────────────────────
//  ATUALIZAR EMBEDS
// ─────────────────────────────────────────────
async function atualizarEmbedPublico(salaId, guild) {
  const sala = salas.get(salaId);
  if (!sala) return;
  try {
    const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
    if (!salasCh || !sala.embedMessageId) return;
    const msg = await salasCh.messages.fetch(sala.embedMessageId).catch(() => null);
    if (!msg) {
      logger.warn(`Embed publico da sala ${salaId} nao encontrado — sera recriado`);
      const newMsg = await salasCh.send({
        embeds: [buildSalaEmbed(sala)],
        components: [buildSalaBotoes(salaId, sala.membros.size >= sala.vagas, sala.emAndamento, sala.fechando)],
      });
      sala.embedMessageId = newMsg.id;
      salvarEstado();
      return;
    }
    const cheio = sala.membros.size >= sala.vagas;
    await msg.edit({
      embeds: [buildSalaEmbed(sala)],
      components: [buildSalaBotoes(salaId, cheio, sala.emAndamento, sala.fechando)],
    });
  } catch (e) {
    logger.warn(`Erro ao atualizar embed publico da sala ${salaId}: ${e.message}`);
  }
}

async function atualizarEmbedPrivado(salaId, guild) {
  const sala = salas.get(salaId);
  if (!sala) return;
  try {
    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (!textCh) return;

    let pinned = null;
    if (sala.privadoMessageId) {
      pinned = await textCh.messages.fetch(sala.privadoMessageId).catch(() => null);
    }
    if (!pinned) {
      // Fallback: procura msg pinada do bot
      const msgs = await textCh.messages.fetch({ limit: 10 });
      pinned = msgs.find(m => m.author.id === client.user.id && m.pinned);
    }

    if (pinned) {
      await pinned.edit({
        embeds: [buildPrivadoEmbed(sala)],
        components: buildPrivadoBotoes(salaId, sala.criadorId, sala.emAndamento),
      });
    }
  } catch (e) {
    logger.warn(`Erro ao atualizar embed privado da sala ${salaId}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────
//  CLEANUP DE CANAIS ORFAOS
// ─────────────────────────────────────────────
async function limparOrfaos(guild) {
  logger.info('Iniciando limpeza de canais orfaos...');
  let removidos = 0;

  try {
    // IDs de canais que NAO devem ser deletados
    const canaisProtegidos = new Set([
      SALAS_CHANNEL_ID,
      ADMIN_SALAS_CHANNEL_ID,
      CUSTOM_CATEGORY_ID,
    ].filter(Boolean));

    // IDs de canais ativos (salas no Map)
    for (const sala of salas.values()) {
      canaisProtegidos.add(sala.textChannelId);
    }

    // Busca todos os canais na categoria
    const canaisNaCategoria = guild.channels.cache.filter(
      c => c.parentId === CUSTOM_CATEGORY_ID && c.type === ChannelType.GuildText
    );

    for (const [channelId, channel] of canaisNaCategoria) {
      if (canaisProtegidos.has(channelId)) continue;

      // Canal orfao — nao pertence a nenhuma sala ativa
      logger.info(`Deletando canal orfao: #${channel.name} (${channelId})`);
      await channel.delete(`Limpeza de canal orfao pelo bot`).catch(e =>
        logger.error(`Erro ao deletar canal orfao ${channelId}: ${e.message}`)
      );
      removidos++;
    }

    // Limpa embeds orfaos no #salas
    const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
    if (salasCh) {
      const msgs = await salasCh.messages.fetch({ limit: 50 });
      const embedIds = new Set([...salas.values()].map(s => s.embedMessageId).filter(Boolean));

      for (const [, msg] of msgs) {
        if (msg.author.id !== client.user.id) continue;
        // Preserva a msg do botao "Criar Sala"
        const hasCriar = msg.components[0]?.components?.some(c => c.customId === 'criar_sala');
        if (hasCriar) continue;
        // Se nao e embed de sala ativa, deleta
        if (!embedIds.has(msg.id)) {
          await msg.delete().catch(e => logger.warn(`Erro ao deletar embed orfao: ${e.message}`));
          removidos++;
        }
      }
    }

  } catch (e) {
    logger.error(`Erro durante limpeza de orfaos: ${e.message}`);
  }

  logger.info(`Limpeza concluida: ${removidos} item(ns) orfao(s) removido(s)`);
  return removidos;
}

// ─────────────────────────────────────────────
//  RESTAURAR SALAS DO STATE.JSON
// ─────────────────────────────────────────────
async function restaurarSalas(guild) {
  const salasCarregadas = carregarEstado();
  let restauradas = 0;
  let removidas = 0;

  for (const [id, sala] of salasCarregadas) {
    // Verifica se o canal privado ainda existe
    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (!textCh) {
      logger.warn(`Canal da sala ${id} (${sala.nome}) nao existe mais — descartando`);
      // Tenta limpar embed publico
      try {
        const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
        if (salasCh && sala.embedMessageId) {
          const msg = await salasCh.messages.fetch(sala.embedMessageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      } catch {}
      removidas++;
      continue;
    }

    // Restaura no Map
    salas.set(id, sala);

    // Restaura timeout de votacao se ativa
    if (sala.votacao.ativa && sala.votacao.iniciadaEm) {
      const elapsed = Date.now() - sala.votacao.iniciadaEm;
      if (elapsed >= VOTE_TIMEOUT_MS) {
        // Ja expirou — cancela
        sala.votacao = { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null };
        const textCh2 = guild.channels.cache.get(sala.textChannelId);
        if (textCh2) {
          await textCh2.send('\u23F0 Votacao anterior expirou durante reinicio do bot.').catch(() => {});
        }
      } else {
        // Restarta com tempo restante
        iniciarVotacaoTimeout(id, guild);
      }
    }

    // Atualiza embeds para refletir estado atual
    await atualizarEmbedPublico(id, guild);
    await atualizarEmbedPrivado(id, guild);

    restauradas++;
    logger.info(`Sala ${id} (${sala.nome}) restaurada com sucesso`);
  }

  logger.info(`Restauracao: ${restauradas} sala(s) restaurada(s), ${removidas} descartada(s)`);
  salvarEstado();
}

// ─────────────────────────────────────────────
//  BOT PRONTO
// ─────────────────────────────────────────────
client.once('ready', async () => {
  logger.info(`Bot online: ${client.user.tag}`);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    logger.error('Servidor nao encontrado! Verifique GUILD_ID no .env');
    return process.exit(1);
  }

  const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
  if (!salasCh) {
    logger.error('Canal de salas nao encontrado! Verifique SALAS_CHANNEL_ID no .env');
    return process.exit(1);
  }

  // 1) Restaura salas do state.json
  await restaurarSalas(guild);

  // 2) Limpa canais orfaos
  await limparOrfaos(guild);

  // 3) Limpa mensagens antigas do botao "Criar Sala" e recria
  const msgs = await salasCh.messages.fetch({ limit: 20 });
  for (const [, m] of msgs) {
    if (m.author.id === client.user.id && m.components.length > 0) {
      const hasCreate = m.components[0]?.components?.some(c => c.customId === 'criar_sala');
      if (hasCreate) await m.delete().catch(() => {});
    }
  }

  const criarEmbed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('\uD83C\uDFAE Custom Game — Salas Ativas')
    .setDescription(
      'Clique no botao abaixo para criar uma sala de custom game.\n' +
      'As salas ativas aparecerao aqui em tempo real.\n\n' +
      '*Apenas membros com cargo \uD83C\uDFAE Jogador ou superior podem criar salas.*' +
      (DEBUG ? '\n\n\u26A0\uFE0F **MODO DEBUG ATIVO**' : '')
    )
    .setFooter({ text: 'Arkheron SA \u2022 Custom Game' });

  const criarRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('criar_sala')
      .setLabel('\uD83C\uDFAE Criar Sala')
      .setStyle(ButtonStyle.Primary),
  );

  await salasCh.send({ embeds: [criarEmbed], components: [criarRow] });
  logger.info('Painel de salas enviado');

  // 4) Painel de administracao
  if (ADMIN_SALAS_CHANNEL_ID) {
    const adminCh = guild.channels.cache.get(ADMIN_SALAS_CHANNEL_ID);
    if (adminCh) {
      const adminMsgs = await adminCh.messages.fetch({ limit: 20 });
      for (const [, m] of adminMsgs) {
        if (m.author.id === client.user.id) await m.delete().catch(() => {});
      }

      await adminCh.send({
        embeds: [buildAdminPainelEmbed()],
        components: buildAdminPainelBotoes(),
      });
      logger.info('Painel de administracao enviado');
    }
  }

  // 5) Auto-cleanup de salas antigas (verifica a cada 30 min)
  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);
    const maxAge = MAX_ROOM_AGE_H * 3600;

    for (const [salaId, sala] of salas) {
      if (sala.fechando) continue;
      if (now - sala.criadoEm > maxAge) {
        logger.info(`Auto-fechando sala antiga ${salaId} (${sala.nome}) — ${MAX_ROOM_AGE_H}h+ de vida`);
        await agendarFechamento(salaId, guild, `timeout automatico (${MAX_ROOM_AGE_H}h+)`);
      }
    }
  }, 30 * 60 * 1000);

  logger.info('Bot totalmente inicializado!');
});

// ─────────────────────────────────────────────
//  INTERACOES
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    const guild = interaction.guild;

    // ── BOTAO: Criar Sala ──
    if (interaction.isButton() && interaction.customId === 'criar_sala') {
      const member = interaction.member;

      if (!temCargoMinimo(member)) {
        return interaction.reply({
          content: '\u274C Voce precisa ter o cargo **\uD83C\uDFAE Jogador** ou superior para criar uma sala!',
          ephemeral: true,
        });
      }

      // Limite de salas
      if (salas.size >= MAX_SALAS) {
        return interaction.reply({
          content: `\u274C Limite de ${MAX_SALAS} salas ativas atingido! Aguarde alguma sala fechar.`,
          ephemeral: true,
        });
      }

      // Verifica se ja tem sala ativa
      const jaTemSala = [...salas.values()].some(s => s.criadorId === interaction.user.id && !s.fechando);
      if (jaTemSala) {
        return interaction.reply({
          content: '\u274C Voce ja tem uma sala ativa! Feche a sala atual antes de criar uma nova.',
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId('modal_criar_sala')
        .setTitle('\uD83C\uDFAE Criar Sala de Custom Game');

      const nomeInput = new TextInputBuilder()
        .setCustomId('sala_nome')
        .setLabel('Nome da sala')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex: Casual iniciantes, Ranked veteranos...')
        .setMaxLength(50)
        .setRequired(true);

      const codigoInput = new TextInputBuilder()
        .setCustomId('sala_codigo')
        .setLabel('Codigo do lobby')
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

      const nome = interaction.fields.getTextInputValue('sala_nome');
      const codigo = interaction.fields.getTextInputValue('sala_codigo');
      const vagas = 60;
      const salaId = gerarId();
      const criadorId = interaction.user.id;

      const categoria = guild.channels.cache.get(CUSTOM_CATEGORY_ID);
      if (!categoria) {
        return interaction.editReply({ content: '\u274C Categoria de salas nao encontrada! Configure CUSTOM_CATEGORY_ID no .env' });
      }

      const permBase = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
        { id: criadorId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ];

      const textChannel = await guild.channels.create({
        name: `\uD83C\uDFAE\u30FB${nome.toLowerCase().replace(/\s+/g, '-').substring(0, 30)}`,
        type: ChannelType.GuildText,
        parent: categoria.id,
        permissionOverwrites: permBase,
        topic: `Sala de custom game | Criador: ${interaction.user.username} | Codigo: ${codigo}`,
      });

      const sala = {
        id: salaId,
        nome,
        codigo,
        vagas,
        criadorId,
        membros: new Set([criadorId]),
        embedMessageId: null,
        textChannelId: textChannel.id,
        privadoMessageId: null,
        criadoEm: Math.floor(Date.now() / 1000),
        votacao: { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null },
        emAndamento: false,
        fechando: false,
      };
      salas.set(salaId, sala);

      // Posta embed publico
      const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
      const embedMsg = await salasCh.send({
        embeds: [buildSalaEmbed(sala)],
        components: [buildSalaBotoes(salaId, false, false, false)],
      });
      sala.embedMessageId = embedMsg.id;

      // Posta embed privado
      const privMsg = await textChannel.send({
        content: `<@${criadorId}>`,
        embeds: [buildPrivadoEmbed(sala)],
        components: buildPrivadoBotoes(salaId, criadorId, false),
      });
      await privMsg.pin();
      sala.privadoMessageId = privMsg.id;

      salvarEstado();

      await logDiscord(guild, `\uD83C\uDFAE Sala **${nome}** criada por <@${criadorId}> | Vagas: ${vagas} | ID: ${salaId}`);
      await interaction.editReply({ content: `\u2705 Sala **${nome}** criada! Acesse: ${textChannel}` });
      await atualizarPainelAdmin(guild).catch(() => {});

      logger.info(`Sala ${salaId} (${nome}) criada por ${criadorId}. Total: ${salas.size}`);
      return;
    }

    // ── BOTAO: Entrar na Sala ──
    if (interaction.isButton() && interaction.customId.startsWith('entrar_')) {
      const salaId = interaction.customId.replace('entrar_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) {
        return interaction.reply({ content: '\u274C Sala nao encontrada ou ja esta sendo fechada.', ephemeral: true });
      }
      if (sala.emAndamento) return interaction.reply({ content: '\u274C A partida ja esta em andamento!', ephemeral: true });
      if (sala.membros.size >= sala.vagas) return interaction.reply({ content: '\u274C Sala cheia!', ephemeral: true });
      if (sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voce ja esta nessa sala!', ephemeral: true });

      sala.membros.add(interaction.user.id);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) {
        await textCh.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
      }

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      if (textCh) {
        await textCh.send(`\u2705 <@${interaction.user.id}> entrou na sala! (${sala.membros.size}/${sala.vagas})`);
      }

      salvarEstado();
      await interaction.reply({ content: `\u2705 Voce entrou! Acesse: ${textCh}`, ephemeral: true });
      return;
    }

    // ── BOTAO: Sair da Sala (publico) ──
    if (interaction.isButton() && interaction.customId.startsWith('sair_') && !interaction.customId.startsWith('sair_privado_')) {
      const salaId = interaction.customId.replace('sair_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) {
        return interaction.reply({ content: '\u274C Sala nao encontrada ou ja esta sendo fechada.', ephemeral: true });
      }
      if (sala.emAndamento) return interaction.reply({ content: '\u274C A partida esta em andamento!', ephemeral: true });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voce nao esta nessa sala.', ephemeral: true });

      await interaction.reply({ content: '\u2705 Voce saiu da sala.', ephemeral: true });
      await removerMembro(salaId, interaction.user.id, guild);
      return;
    }

    // ── BOTAO: Sair da Sala (privado) ──
    if (interaction.isButton() && interaction.customId.startsWith('sair_privado_')) {
      const salaId = interaction.customId.replace('sair_privado_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) {
        return interaction.reply({ content: '\u274C Sala nao encontrada ou ja esta sendo fechada.', ephemeral: true });
      }
      if (sala.emAndamento) return interaction.reply({ content: '\u274C A partida esta em andamento!', ephemeral: true });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voce nao esta nessa sala.', ephemeral: true });

      await interaction.reply({ content: '\u2705 Voce saiu da sala.', ephemeral: true });
      await removerMembro(salaId, interaction.user.id, guild);
      return;
    }

    // ── BOTAO: Partida Acabou (inicia votacao) ──
    if (interaction.isButton() && interaction.customId.startsWith('partida_acabou_')) {
      const salaId = interaction.customId.replace('partida_acabou_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala nao encontrada ou ja esta sendo fechada.', ephemeral: true });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voce nao esta nessa sala.', ephemeral: true });
      if (sala.votacao.ativa) return interaction.reply({ content: '\u274C Ja tem uma votacao em andamento!', ephemeral: true });

      // Inicia votacao
      sala.votacao = {
        ativa: true,
        sim: new Set(),
        nao: new Set(),
        messageId: null,
        iniciadaEm: Date.now(),
      };

      const textCh = guild.channels.cache.get(sala.textChannelId);
      const votMsg = await textCh.send({
        content: '@here \uD83D\uDDF3\uFE0F Votacao iniciada! Voces tem **' + Math.floor(VOTE_TIMEOUT_MS / 60000) + ' minuto(s)** para votar.',
        embeds: [buildVotacaoEmbed(sala)],
        components: [buildVotacaoBotoes(salaId)],
      });
      sala.votacao.messageId = votMsg.id;

      // Inicia timeout
      iniciarVotacaoTimeout(salaId, guild);

      salvarEstado();
      await interaction.reply({ content: '\u2705 Votacao iniciada!', ephemeral: true });

      logger.info(`Votacao iniciada na sala ${salaId} por ${interaction.user.id}`);
      return;
    }

    // ── BOTAO: Votar Sim ──
    if (interaction.isButton() && interaction.customId.startsWith('votar_sim_')) {
      const salaId = interaction.customId.replace('votar_sim_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando || !sala.votacao.ativa) {
        return interaction.reply({ content: '\u274C Votacao nao encontrada ou sala sendo fechada.', ephemeral: true });
      }
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voce nao esta nessa sala.', ephemeral: true });

      sala.votacao.sim.add(interaction.user.id);
      sala.votacao.nao.delete(interaction.user.id);

      // Atualiza embed da votacao
      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && sala.votacao.messageId) {
        const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
        if (votMsg) {
          await votMsg.edit({
            embeds: [buildVotacaoEmbed(sala)],
            components: [buildVotacaoBotoes(salaId)],
          });
        }
      }

      // Verifica quorum
      const precisam = calcularVotosNecessarios(sala.membros.size);
      if (sala.votacao.sim.size >= precisam) {
        cancelarVotacaoTimeout(salaId);
        sala.votacao.ativa = false;

        if (textCh && sala.votacao.messageId) {
          const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
          if (votMsg) {
            await votMsg.edit({
              content: '\u2705 Votos suficientes! \uD83C\uDFC1 **A partida acabou!**',
              embeds: [],
              components: [],
            });
          }
        }

        await interaction.reply({ content: '\u2705 Votacao aprovada! Sala sera fechada.', ephemeral: true });
        await agendarFechamento(salaId, guild, 'votacao (maioria atingida)');
        return;
      }

      salvarEstado();
      await interaction.reply({ content: '\u2705 Voto registrado: **Sim**', ephemeral: true });
      return;
    }

    // ── BOTAO: Votar Nao ──
    if (interaction.isButton() && interaction.customId.startsWith('votar_nao_')) {
      const salaId = interaction.customId.replace('votar_nao_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando || !sala.votacao.ativa) {
        return interaction.reply({ content: '\u274C Votacao nao encontrada ou sala sendo fechada.', ephemeral: true });
      }
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voce nao esta nessa sala.', ephemeral: true });

      sala.votacao.nao.add(interaction.user.id);
      sala.votacao.sim.delete(interaction.user.id);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && sala.votacao.messageId) {
        const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
        if (votMsg) {
          await votMsg.edit({
            embeds: [buildVotacaoEmbed(sala)],
            components: [buildVotacaoBotoes(salaId)],
          });
        }
      }

      salvarEstado();
      await interaction.reply({ content: '\u2705 Voto registrado: **Nao**', ephemeral: true });
      return;
    }

    // ── BOTAO: Cancelar Votacao ──
    if (interaction.isButton() && interaction.customId.startsWith('votar_cancelar_')) {
      const salaId = interaction.customId.replace('votar_cancelar_', '');
      const sala = salas.get(salaId);

      if (!sala || !sala.votacao.ativa) {
        return interaction.reply({ content: '\u274C Nenhuma votacao ativa.', ephemeral: true });
      }

      // Apenas o criador pode cancelar
      if (sala.criadorId !== interaction.user.id) {
        return interaction.reply({ content: '\u274C Apenas o criador da sala pode cancelar a votacao.', ephemeral: true });
      }

      cancelarVotacaoTimeout(salaId);
      sala.votacao = { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null };

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && sala.votacao.messageId) {
        const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
        if (votMsg) {
          await votMsg.edit({
            content: '\u23F9\uFE0F **Votacao cancelada pelo criador.**',
            embeds: [],
            components: [],
          });
        }
      }

      salvarEstado();
      await interaction.reply({ content: '\u2705 Votacao cancelada.', ephemeral: true });
      logger.info(`Votacao cancelada na sala ${salaId} pelo criador`);
      return;
    }

    // ── BOTAO: Toggle Partida em Andamento (criador) ──
    if (interaction.isButton() && interaction.customId.startsWith('toggle_andamento_')) {
      const salaId = interaction.customId.replace('toggle_andamento_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala nao encontrada.', ephemeral: true });
      if (sala.criadorId !== interaction.user.id) {
        return interaction.reply({ content: '\u274C Apenas o criador pode alterar o status da partida.', ephemeral: true });
      }

      sala.emAndamento = !sala.emAndamento;
      const novoStatus = sala.emAndamento ? '\uD83D\uDD34 Partida iniciada!' : '\uD83D\uDFE2 Partida pausada!';

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.send(`${novoStatus} Status alterado por <@${interaction.user.id}>`).catch(() => {});

      salvarEstado();
      await interaction.reply({ content: `\u2705 ${novoStatus}`, ephemeral: true });
      return;
    }

    // ── BOTAO: Encerrar Partida (criador) ──
    if (interaction.isButton() && interaction.customId.startsWith('encerrar_partida_')) {
      const salaId = interaction.customId.replace('encerrar_partida_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala nao encontrada ou ja esta fechando.', ephemeral: true });
      if (sala.criadorId !== interaction.user.id) {
        return interaction.reply({ content: '\u274C Apenas o criador pode encerrar a partida.', ephemeral: true });
      }

      await interaction.reply({ content: `\uD83C\uDFC1 Encerrando partida em ${CLOSE_DELAY_SEC} segundos...`, ephemeral: true });
      await agendarFechamento(salaId, guild, `encerrada pelo lider (<@${interaction.user.id}>)`);
      return;
    }

    // ── BOTAO: Forcar Fechar (criador) ──
    if (interaction.isButton() && interaction.customId.startsWith('forcar_fechar_')) {
      const salaId = interaction.customId.replace('forcar_fechar_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala nao encontrada ou ja esta fechando.', ephemeral: true });
      if (sala.criadorId !== interaction.user.id) {
        return interaction.reply({ content: '\u274C Apenas o criador pode forcar o fechamento.', ephemeral: true });
      }

      await interaction.reply({ content: `\uD83D\uDDD1\uFE0F Fechando sala em ${CLOSE_DELAY_SEC} segundos...`, ephemeral: true });
      await agendarFechamento(salaId, guild, `criador (<@${interaction.user.id}>)`);
      return;
    }

    // ── ADMIN: Refresh Painel ──
    if (interaction.isButton() && interaction.customId === 'admin_refresh') {
      if (!ehAdmin(interaction.member)) {
        return interaction.reply({ content: '\u274C Voce nao tem permissao para usar este painel!', ephemeral: true });
      }

      await atualizarPainelAdmin(guild);
      await interaction.reply({ content: '\u2705 Painel atualizado!', ephemeral: true });
      return;
    }

    // ── ADMIN: Deletar Todas as Salas ──
    if (interaction.isButton() && interaction.customId === 'admin_delete_all') {
      if (!ehAdmin(interaction.member)) {
        return interaction.reply({ content: '\u274C Voce nao tem permissao!', ephemeral: true });
      }

      const salasArray = Array.from(salas.keys()).filter(id => !salas.get(id).fechando);
      if (salasArray.length === 0) {
        return interaction.reply({ content: '\u274C Nao ha salas ativas para fechar!', ephemeral: true });
      }

      await interaction.reply({ content: `\uD83D\uDDD1\uFE0F Fechando ${salasArray.length} sala(s) em ${CLOSE_DELAY_SEC}s...`, ephemeral: true });

      for (const salaId of salasArray) {
        await agendarFechamento(salaId, guild, `administrador (<@${interaction.user.id}>)`);
      }
      return;
    }

    // ── ADMIN: Limpar Orfaos ──
    if (interaction.isButton() && interaction.customId === 'admin_cleanup_orfaos') {
      if (!ehAdmin(interaction.member)) {
        return interaction.reply({ content: '\u274C Voce nao tem permissao!', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const removidos = await limparOrfaos(guild);
      await interaction.editReply({ content: `\uD83E\uDDF9 Limpeza concluida: **${removidos}** item(ns) orfao(s) removido(s).` });
      return;
    }

    // ── ADMIN: Select Menu - Deletar Sala Especifica ──
    if (interaction.isStringSelectMenu() && interaction.customId === 'admin_select_sala') {
      if (!ehAdmin(interaction.member)) {
        return interaction.reply({ content: '\u274C Voce nao tem permissao!', ephemeral: true });
      }

      const salaId = interaction.values[0];
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) {
        return interaction.reply({ content: '\u274C Sala nao encontrada ou ja esta sendo fechada!', ephemeral: true });
      }

      await interaction.reply({ content: `\uD83D\uDDD1\uFE0F Fechando sala **${sala.nome}** em ${CLOSE_DELAY_SEC}s...`, ephemeral: true });
      await agendarFechamento(salaId, guild, `administrador (<@${interaction.user.id}>)`);
      return;
    }

  } catch (error) {
    logger.error(`Erro na interacao ${interaction?.customId || interaction?.commandName || 'desconhecida'}: ${error.stack || error.message}`);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '\u274C Ocorreu um erro interno. Tente novamente.', ephemeral: true });
      } else {
        await interaction.followUp({ content: '\u274C Ocorreu um erro interno. Tente novamente.', ephemeral: true });
      }
    } catch {
      // Falhou ao responder o erro — nada a fazer
    }
  }
});

// ─────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
async function gracefulShutdown(signal) {
  logger.info(`Recebido ${signal} — iniciando shutdown graceful...`);

  try {
    const guild = client.guilds.cache.get(GUILD_ID);

    if (guild) {
      // Avisa nas salas ativas
      for (const [, sala] of salas) {
        if (sala.fechando) continue;
        try {
          const textCh = guild.channels.cache.get(sala.textChannelId);
          if (textCh) {
            await textCh.send('\u26A0\uFE0F **O bot esta reiniciando.** As salas serao restauradas automaticamente apos o reinicio.').catch(() => {});
          }
        } catch {}
      }
    }

    // Salva estado antes de sair
    salvarEstado();
    logger.info(`Estado salvo com ${salas.size} sala(s). Saindo...`);

    // Limpa timers
    for (const [salaId] of voteTimeouts) {
      cancelarVotacaoTimeout(salaId);
    }

    client.destroy();
  } catch (e) {
    logger.error(`Erro durante shutdown: ${e.message}`);
  }

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─────────────────────────────────────────────
//  TRATAMENTO DE ERROS GLOBAIS
// ─────────────────────────────────────────────
client.on('error', (error) => {
  logger.error(`Discord Client Error: ${error.stack || error.message}`);
});

process.on('unhandledRejection', (error) => {
  logger.error(`Unhandled Promise Rejection: ${error?.stack || error}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`FATAL — Uncaught Exception: ${error.stack || error.message}`);
  // Salva estado e sai — pm2 vai reiniciar
  salvarEstado();
  process.exit(1);
});

// ─────────────────────────────────────────────
//  LOGIN
// ─────────────────────────────────────────────
client.login(DISCORD_TOKEN).catch(err => {
  logger.error(`Token invalido: ${err.message}`);
  process.exit(1);
});
