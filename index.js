// ================================================================
//  ARKHERON SA — Custom Game Bot v3.0
//  Features: persistencia, cleanup, votacao com timeout,
//  graceful shutdown, debug mode, winston, transfer de lider,
//  cooldown, confirmacao destrutiva, lista membros, barra progresso,
//  DM codigo, historico, FAQ interativo
// ================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client, GatewayIntentBits, PermissionFlagsBits,
  ChannelType, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
  MessageFlags, REST, Routes,
} = require('discord.js');
const winston = require('winston');

// ─────────────────────────────────────────────
//  HTTP HEALTH CHECK (Render precisa de porta aberta)
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), salas: salas?.size ?? 0 }));
}).listen(PORT);

// ─────────────────────────────────────────────
//  LOGGER
// ─────────────────────────────────────────────
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(logsDir, 'bot.log'), maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error', maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
  ],
});

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
//  CONFIG
// ─────────────────────────────────────────────
const {
  DISCORD_TOKEN, GUILD_ID, SALAS_CHANNEL_ID,
  CUSTOM_CATEGORY_ID, LOG_CHANNEL_ID, MIN_ROLE_ID,
  ADMIN_SALAS_CHANNEL_ID, NOTIFY_ROLE_ID,
} = process.env;

const DEBUG = process.env.DEBUG_MODE === 'true';
const SKIP_ROLE_CHECK = DEBUG && process.env.DEBUG_SKIP_ROLE_CHECK === 'true';
const VOTE_TIMEOUT_MS = parseInt(process.env.VOTE_TIMEOUT_MS || '180000');
const CLOSE_DELAY_SEC = DEBUG ? 3 : 10;
const MAX_SALAS = parseInt(process.env.MAX_SALAS || '20');
const MAX_ROOM_AGE_H = parseInt(process.env.MAX_ROOM_AGE_H || '6');
const COOLDOWN_MS = DEBUG ? 0 : parseInt(process.env.COOLDOWN_MS || '180000');

if (DEBUG) {
  logger.warn('>>> MODO DEBUG ATIVO <<<');
  logger.info(`  SKIP_ROLE_CHECK=${SKIP_ROLE_CHECK} | VOTE_TIMEOUT=${VOTE_TIMEOUT_MS}ms | CLOSE_DELAY=${CLOSE_DELAY_SEC}s | COOLDOWN=0`);
}

// ─────────────────────────────────────────────
//  PERSISTENCIA DE ESTADO
// ─────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');
const HISTORICO_FILE = path.join(__dirname, 'historico.json');

function salvarEstado() {
  try {
    const data = {};
    for (const [id, sala] of salas) {
      data[id] = {
        id: sala.id, nome: sala.nome, codigo: sala.codigo, vagas: sala.vagas,
        criadorId: sala.criadorId, membros: Array.from(sala.membros),
        embedMessageId: sala.embedMessageId, textChannelId: sala.textChannelId,
        privadoMessageId: sala.privadoMessageId, criadoEm: sala.criadoEm,
        emAndamento: sala.emAndamento,
        votacao: {
          ativa: sala.votacao.ativa, sim: Array.from(sala.votacao.sim),
          nao: Array.from(sala.votacao.nao), messageId: sala.votacao.messageId,
          iniciadaEm: sala.votacao.iniciadaEm || null,
        },
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ salas: data, savedAt: Date.now() }, null, 2));
  } catch (e) { logger.error(`Erro ao salvar estado: ${e.message}`); }
}

function carregarEstado() {
  try {
    if (!fs.existsSync(STATE_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const loaded = new Map();
    for (const [id, s] of Object.entries(raw.salas || {})) {
      loaded.set(id, {
        ...s, membros: new Set(s.membros), fechando: false,
        votacao: { ativa: s.votacao.ativa, sim: new Set(s.votacao.sim), nao: new Set(s.votacao.nao), messageId: s.votacao.messageId, iniciadaEm: s.votacao.iniciadaEm || null },
      });
    }
    logger.info(`Estado carregado: ${loaded.size} sala(s)`);
    return loaded;
  } catch (e) { logger.warn(`Erro ao carregar estado: ${e.message}`); return new Map(); }
}

// ─────────────────────────────────────────────
//  HISTORICO DE PARTIDAS
// ─────────────────────────────────────────────
function salvarHistorico(registro) {
  try {
    let historico = [];
    if (fs.existsSync(HISTORICO_FILE)) {
      historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf-8'));
    }
    historico.push(registro);
    // Mantém apenas as últimas 200 partidas
    if (historico.length > 200) historico = historico.slice(-200);
    fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));
  } catch (e) { logger.error(`Erro ao salvar historico: ${e.message}`); }
}

function carregarHistorico(limite = 10) {
  try {
    if (!fs.existsSync(HISTORICO_FILE)) return [];
    const historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf-8'));
    return historico.slice(-limite);
  } catch { return []; }
}

function carregarHistoricoUsuario(userId, limite = 10) {
  try {
    if (!fs.existsSync(HISTORICO_FILE)) return [];
    const historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf-8'));
    const doUsuario = historico.filter(h => h.membrosIds && h.membrosIds.includes(userId));
    return doUsuario.slice(-limite);
  } catch { return []; }
}

// ─────────────────────────────────────────────
//  MEMORIA
// ─────────────────────────────────────────────
const salas = new Map();
const voteTimeouts = new Map();
const cooldowns = new Map(); // userId -> timestamp do ultimo fechamento

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function gerarId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function logDiscord(guild, msg) {
  try {
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (ch) await ch.send(`\`[${new Date().toLocaleTimeString('pt-BR')}]\` ${msg}`);
  } catch (e) { logger.warn(`Erro log Discord: ${e.message}`); }
}

function calcularVotosNecessarios(total) {
  if (DEBUG) return parseInt(process.env.DEBUG_MIN_VOTES || '1');
  return Math.max(2, Math.ceil(total * 0.6));
}

function temCargoMinimo(member) {
  if (SKIP_ROLE_CHECK) return true;
  return member.roles.cache.has(MIN_ROLE_ID) ||
    member.roles.cache.some(r => ['\uD83D\uDC51 Dono','\u2699\uFE0F Admin','\uD83D\uDEE1\uFE0F Moderador','\uD83D\uDD27 Helper','\u2B50 Veterano','\uD83D\uDD25 Ativo'].includes(r.name));
}

function ehAdmin(member) {
  if (SKIP_ROLE_CHECK) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.some(r => ['\uD83D\uDC51 Dono','\u2699\uFE0F Admin','\uD83D\uDEE1\uFE0F Moderador'].includes(r.name));
}

function barraProgresso(current, max, size = 20) {
  const pct = Math.min(current / max, 1);
  const filled = Math.round(pct * size);
  const empty = size - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + ` ${current}/${max}`;
}

function listaMembros(sala) {
  const ids = Array.from(sala.membros);
  const MAX_SHOW = 20;
  const lista = ids.slice(0, MAX_SHOW).map(id => {
    const isLider = id === sala.criadorId;
    return `${isLider ? '\uD83D\uDC51' : '\u2022'} <@${id}>`;
  });
  if (ids.length > MAX_SHOW) {
    lista.push(`*...e mais ${ids.length - MAX_SHOW} jogador(es)*`);
  }
  return lista.join('\n') || '*Nenhum membro*';
}

// ─────────────────────────────────────────────
//  BUILDERS — Embeds e Botoes
// ─────────────────────────────────────────────
function buildSalaEmbed(sala) {
  const count = sala.membros.size;
  const cheio = count >= sala.vagas;
  const status = sala.fechando
    ? '\uD83D\uDFE1 Fechando...'
    : sala.emAndamento ? '\uD83D\uDD34 Partida em andamento' : '\uD83D\uDFE2 Esperando jogadores';

  return new EmbedBuilder()
    .setColor(sala.fechando ? 0xfbbf24 : sala.emAndamento ? 0xf59e0b : (cheio ? 0xef4444 : 0x7B2FBE))
    .setTitle(`\uD83C\uDFAE ${sala.nome}`)
    .addFields(
      { name: '\uD83D\uDCCA Status', value: status, inline: true },
      { name: '\uD83D\uDC64 L\u00edder', value: `<@${sala.criadorId}>`, inline: true },
      { name: '\u23F1\uFE0F Criada', value: `<t:${sala.criadoEm}:R>`, inline: true },
      { name: '\uD83D\uDC65 Vagas', value: barraProgresso(count, sala.vagas), inline: false },
    )
    .setFooter({ text: cheio ? '\uD83D\uDD34 Sala cheia' : '\uD83D\uDFE2 Aceitando jogadores' });
}

function buildSalaBotoes(salaId, cheio = false, emAndamento = false, fechando = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`entrar_${salaId}`).setLabel('\u2705 Entrar na Sala').setStyle(ButtonStyle.Success).setDisabled(cheio || emAndamento || fechando),
    new ButtonBuilder().setCustomId(`sair_${salaId}`).setLabel('\uD83D\uDEAA Sair da Sala').setStyle(ButtonStyle.Secondary).setDisabled(emAndamento || fechando),
  );
}

function buildPrivadoEmbed(sala) {
  return new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle(`\uD83C\uDFAE ${sala.nome} — Canal Privado`)
    .setDescription('Bem-vindo! O c\u00f3digo do lobby e a lista de participantes est\u00e3o abaixo.\n*Bot\u00f5es de gerenciamento s\u00e3o exclusivos do l\u00edder.*')
    .addFields(
      { name: '\uD83D\uDD11 C\u00f3digo do Lobby', value: `\`\`\`${sala.codigo}\`\`\``, inline: false },
      { name: '\uD83D\uDC65 Participantes', value: barraProgresso(sala.membros.size, sala.vagas), inline: false },
      { name: '\uD83D\uDCCB Membros', value: listaMembros(sala), inline: false },
      { name: '\uD83D\uDC51 L\u00edder', value: `<@${sala.criadorId}>`, inline: true },
    )
    .setFooter({ text: 'Boa partida!' });
}

function buildPrivadoBotoes(salaId, emAndamento) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`partida_acabou_${salaId}`).setLabel('\uD83C\uDFC1 Partida Acabou').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sair_privado_${salaId}`).setLabel('\uD83D\uDEAA Sair da Sala').setStyle(ButtonStyle.Secondary).setDisabled(emAndamento),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`toggle_andamento_${salaId}`).setLabel(emAndamento ? '\u23F8\uFE0F Pausar Partida' : '\u25B6\uFE0F Iniciar Partida').setStyle(emAndamento ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`alterar_codigo_${salaId}`).setLabel('\u270F\uFE0F Alterar C\u00f3digo').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`transferir_lider_${salaId}`).setLabel('\uD83D\uDC51 Transferir L\u00edder').setStyle(ButtonStyle.Primary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`encerrar_partida_${salaId}`).setLabel('\uD83C\uDFC1 Encerrar Partida').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`forcar_fechar_${salaId}`).setLabel('\uD83D\uDDD1\uFE0F Fechar Sala').setStyle(ButtonStyle.Danger),
  );

  return [row1, row2, row3];
}

function buildVotacaoEmbed(sala) {
  const v = sala.votacao;
  const total = v.sim.size + v.nao.size;
  const precisam = calcularVotosNecessarios(sala.membros.size);
  const faltam = Math.max(0, precisam - v.sim.size);
  const restante = v.iniciadaEm ? Math.max(0, Math.ceil((v.iniciadaEm + VOTE_TIMEOUT_MS - Date.now()) / 1000)) : 0;

  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('\u2694\uFE0F Vota\u00e7\u00e3o — A partida acabou?')
    .addFields(
      { name: '\u2705 Sim', value: `${v.sim.size} votos`, inline: true },
      { name: '\u274C N\u00e3o', value: `${v.nao.size} votos`, inline: true },
      { name: '\uD83D\uDCCA Total', value: `${total} votos`, inline: true },
      { name: '\u26A0\uFE0F Para fechar', value: faltam > 0 ? `Faltam **${faltam}** votos em Sim` : '\u2705 Votos suficientes!', inline: false },
    )
    .setFooter({ text: `M\u00ednimo: ${precisam} votos Sim | Expira em ${Math.floor(restante / 60)}m${restante % 60}s` });
}

function buildVotacaoBotoes(salaId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`votar_sim_${salaId}`).setLabel('\u2705 Sim, acabou').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`votar_nao_${salaId}`).setLabel('\u274C N\u00e3o acabou').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`votar_cancelar_${salaId}`).setLabel('\u23F9\uFE0F Cancelar Vota\u00e7\u00e3o').setStyle(ButtonStyle.Secondary),
  );
}

function buildConfirmacao(action, salaId, membrosCount) {
  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle('\u26A0\uFE0F Confirma\u00e7\u00e3o Necess\u00e1ria')
    .setDescription(
      action === 'encerrar'
        ? `Tem certeza que deseja **encerrar a partida**?\nIsso afetar\u00e1 **${membrosCount}** jogador(es). A sala ser\u00e1 fechada ap\u00f3s ${CLOSE_DELAY_SEC}s.`
        : `Tem certeza que deseja **fechar a sala**?\nIsso remover\u00e1 **${membrosCount}** jogador(es) e deletar\u00e1 o canal.`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirmar_${action}_${salaId}`).setLabel('\u2705 Confirmar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cancelar_acao_${salaId}`).setLabel('\u274C Cancelar').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row], flags: MessageFlags.Ephemeral };
}

// ─────────────────────────────────────────────
//  GERENCIAMENTO DE SALAS
// ─────────────────────────────────────────────
async function agendarFechamento(salaId, guild, motivo) {
  const sala = salas.get(salaId);
  if (!sala || sala.fechando) return;

  sala.fechando = true;
  salvarEstado();
  cancelarVotacaoTimeout(salaId);

  await atualizarEmbedPublico(salaId, guild);

  const textCh = guild.channels.cache.get(sala.textChannelId);
  if (textCh) {
    await textCh.send(`\uD83C\uDFC1 **A sala ser\u00e1 fechada em ${CLOSE_DELAY_SEC} segundos...** (${motivo})`).catch(() => {});
  }

  await sleep(CLOSE_DELAY_SEC * 1000);
  await fecharSala(salaId, guild, motivo);
}

async function fecharSala(salaId, guild, motivo = 'desconhecido') {
  const sala = salas.get(salaId);
  if (!sala) return;

  logger.info(`Fechando sala ${salaId} (${sala.nome}) — ${motivo}`);

  // Registra historico
  salvarHistorico({
    id: sala.id,
    nome: sala.nome,
    criadorId: sala.criadorId,
    membros: sala.membros.size,
    membrosIds: Array.from(sala.membros),
    criadoEm: sala.criadoEm,
    fechadoEm: Math.floor(Date.now() / 1000),
    motivo,
  });

  // Registra cooldown do criador
  cooldowns.set(sala.criadorId, Date.now());

  try {
    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (textCh) await textCh.delete().catch(e => logger.error(`Erro deletar canal: ${e.message}`));

    const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
    if (salasCh && sala.embedMessageId) {
      const msg = await salasCh.messages.fetch(sala.embedMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }

    await logDiscord(guild, `\uD83D\uDDD1\uFE0F Sala **${sala.nome}** fechada — ${motivo} | L\u00edder: <@${sala.criadorId}> | Membros: ${sala.membros.size}`);
  } catch (e) { logger.error(`Erro fechar sala: ${e.message}`); }

  cancelarVotacaoTimeout(salaId);
  salas.delete(salaId);
  salvarEstado();
  logger.info(`Sala ${salaId} removida. Restantes: ${salas.size}`);
  await atualizarPainelAdmin(guild).catch(() => {});
}

async function removerMembro(salaId, userId, guild) {
  const sala = salas.get(salaId);
  if (!sala || sala.fechando) return;

  sala.membros.delete(userId);
  sala.votacao.sim.delete(userId);
  sala.votacao.nao.delete(userId);

  const textCh = guild.channels.cache.get(sala.textChannelId);
  if (textCh) await textCh.permissionOverwrites.delete(userId).catch(() => {});

  // Criador saiu — transferir lideranca ou fechar
  if (userId === sala.criadorId) {
    if (sala.membros.size === 0) {
      if (textCh) await textCh.send('\uD83D\uDC64 Último membro saiu. Sala ser\u00e1 fechada...').catch(() => {});
      await agendarFechamento(salaId, guild, '\u00faltimo membro saiu');
      return;
    }

    // Auto-transfer para o membro mais antigo (primeiro no Set)
    const novoLider = [...sala.membros][0];
    sala.criadorId = novoLider;

    if (textCh) {
      await textCh.send(`\uD83D\uDC51 **O l\u00edder saiu.** Lideran\u00e7a transferida automaticamente para <@${novoLider}>!`).catch(() => {});
    }

    await atualizarEmbedPublico(salaId, guild);
    await atualizarEmbedPrivado(salaId, guild);
    salvarEstado();
    return;
  }

  // Membro normal saiu
  await atualizarEmbedPublico(salaId, guild);
  await atualizarEmbedPrivado(salaId, guild);
  if (textCh) await textCh.send(`\uD83D\uDEAA <@${userId}> saiu da sala. (${sala.membros.size}/${sala.vagas})`).catch(() => {});
  salvarEstado();
}

// ─────────────────────────────────────────────
//  VOTACAO
// ─────────────────────────────────────────────
function iniciarVotacaoTimeout(salaId, guild) {
  cancelarVotacaoTimeout(salaId);

  const handle = setTimeout(async () => {
    const sala = salas.get(salaId);
    if (!sala || !sala.votacao.ativa || sala.fechando) return;

    logger.info(`Votacao da sala ${salaId} expirou`);
    const oldMsgId = sala.votacao.messageId;
    sala.votacao = { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null };

    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (textCh && oldMsgId) {
      const votMsg = await textCh.messages.fetch(oldMsgId).catch(() => null);
      if (votMsg) await votMsg.edit({ content: '\u23F0 **Vota\u00e7\u00e3o expirou!** Algu\u00e9m pode iniciar uma nova.', embeds: [], components: [] }).catch(() => {});
    }

    salvarEstado();
    voteTimeouts.delete(salaId);
  }, VOTE_TIMEOUT_MS);

  voteTimeouts.set(salaId, handle);
}

function cancelarVotacaoTimeout(salaId) {
  const h = voteTimeouts.get(salaId);
  if (h) { clearTimeout(h); voteTimeouts.delete(salaId); }
}

// ─────────────────────────────────────────────
//  PAINEL ADMIN
// ─────────────────────────────────────────────
async function atualizarPainelAdmin(guild) {
  if (!ADMIN_SALAS_CHANNEL_ID) return;
  try {
    const adminCh = guild.channels.cache.get(ADMIN_SALAS_CHANNEL_ID);
    if (!adminCh) return;
    const msgs = await adminCh.messages.fetch({ limit: 10 });
    const painelMsg = msgs.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Painel'));
    if (!painelMsg) return;
    await painelMsg.edit({ embeds: [buildAdminEmbed()], components: buildAdminBotoes() });
  } catch (e) { logger.error(`Erro painel admin: ${e.message}`); }
}

function buildAdminEmbed() {
  const arr = Array.from(salas.values());
  const embed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('\uD83D\uDEE1\uFE0F Painel de Administra\u00e7\u00e3o — Salas Ativas')
    .setDescription(arr.length === 0 ? '\uD83D\uDCED Nenhuma sala ativa.' : `\uD83C\uDFAE **${arr.length} sala(s) ativa(s)**`)
    .setFooter({ text: `Atualizado: ${new Date().toLocaleTimeString('pt-BR')}` });

  if (arr.length > 0) {
    const info = arr.map((s, i) => {
      const icon = s.fechando ? '\uD83D\uDFE1' : s.emAndamento ? '\uD83D\uDD34' : '\uD83D\uDFE2';
      return `**${i + 1}.** ${icon} **${s.nome}**\n   \u2514 L\u00edder: <@${s.criadorId}> | ${s.membros.size}/${s.vagas} | ID: \`${s.id}\``;
    }).join('\n\n');
    embed.addFields({ name: '\uD83D\uDCCB Salas', value: info.substring(0, 1024) });
  }
  return embed;
}

function buildAdminBotoes() {
  const arr = Array.from(salas.values());
  const components = [];

  if (arr.length > 0) {
    const options = arr.slice(0, 25).map(s => ({
      label: `${s.nome} (${s.membros.size}/${s.vagas})`.substring(0, 100),
      description: `L\u00edder: ${s.criadorId}`.substring(0, 100),
      value: s.id,
      emoji: s.fechando ? '\uD83D\uDFE1' : s.emAndamento ? '\uD83D\uDD34' : '\uD83D\uDFE2',
    }));
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('admin_select_sala').setPlaceholder('Selecione uma sala para deletar').addOptions(options)
    ));
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_refresh').setLabel('\uD83D\uDD04 Atualizar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('admin_delete_all').setLabel('\uD83D\uDDD1\uFE0F Fechar Todas').setStyle(ButtonStyle.Danger).setDisabled(arr.length === 0),
    new ButtonBuilder().setCustomId('admin_cleanup_orfaos').setLabel('\uD83E\uDDF9 Limpar \u00D3rf\u00e3os').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_historico').setLabel('\uD83D\uDCCA Hist\u00f3rico').setStyle(ButtonStyle.Secondary),
  ));

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
      const newMsg = await salasCh.send({ embeds: [buildSalaEmbed(sala)], components: [buildSalaBotoes(salaId, sala.membros.size >= sala.vagas, sala.emAndamento, sala.fechando)] });
      sala.embedMessageId = newMsg.id;
      salvarEstado();
      return;
    }
    await msg.edit({ embeds: [buildSalaEmbed(sala)], components: [buildSalaBotoes(salaId, sala.membros.size >= sala.vagas, sala.emAndamento, sala.fechando)] });
  } catch (e) { logger.warn(`Erro embed publico: ${e.message}`); }
}

async function atualizarEmbedPrivado(salaId, guild) {
  const sala = salas.get(salaId);
  if (!sala) return;
  try {
    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (!textCh) return;

    let pinned = null;
    if (sala.privadoMessageId) pinned = await textCh.messages.fetch(sala.privadoMessageId).catch(() => null);
    if (!pinned) {
      const msgs = await textCh.messages.fetch({ limit: 10 });
      pinned = msgs.find(m => m.author.id === client.user.id && m.pinned);
    }
    if (pinned) {
      await pinned.edit({
        embeds: [buildPrivadoEmbed(sala)],
        components: buildPrivadoBotoes(salaId, sala.emAndamento),
      });
    }
  } catch (e) { logger.warn(`Erro embed privado: ${e.message}`); }
}

// ─────────────────────────────────────────────
//  CLEANUP ORFAOS
// ─────────────────────────────────────────────
async function limparOrfaos(guild) {
  logger.info('Limpando orfaos...');
  let removidos = 0;
  try {
    const protegidos = new Set([SALAS_CHANNEL_ID, ADMIN_SALAS_CHANNEL_ID, CUSTOM_CATEGORY_ID].filter(Boolean));
    for (const sala of salas.values()) protegidos.add(sala.textChannelId);

    // Protege canal #como-funciona
    const comoFunciona = guild.channels.cache.find(c => c.parentId === CUSTOM_CATEGORY_ID && c.name.includes('como-funciona'));
    if (comoFunciona) protegidos.add(comoFunciona.id);

    const canais = guild.channels.cache.filter(c => c.parentId === CUSTOM_CATEGORY_ID && c.type === ChannelType.GuildText);
    for (const [id, ch] of canais) {
      if (protegidos.has(id)) continue;
      logger.info(`Deletando orfao: #${ch.name}`);
      await ch.delete('Limpeza de orfao').catch(e => logger.error(`Erro deletar orfao: ${e.message}`));
      removidos++;
    }

    const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
    if (salasCh) {
      const msgs = await salasCh.messages.fetch({ limit: 50 });
      const embedIds = new Set([...salas.values()].map(s => s.embedMessageId).filter(Boolean));
      for (const [, msg] of msgs) {
        if (msg.author.id !== client.user.id) continue;
        if (msg.components[0]?.components?.some(c => c.customId === 'criar_sala')) continue;
        if (!embedIds.has(msg.id)) { await msg.delete().catch(() => {}); removidos++; }
      }
    }
  } catch (e) { logger.error(`Erro limpeza: ${e.message}`); }
  logger.info(`Limpeza: ${removidos} orfao(s) removido(s)`);
  return removidos;
}

// ─────────────────────────────────────────────
//  RESTAURAR SALAS
// ─────────────────────────────────────────────
async function restaurarSalas(guild) {
  const carregadas = carregarEstado();
  let ok = 0, fail = 0;

  for (const [id, sala] of carregadas) {
    const textCh = guild.channels.cache.get(sala.textChannelId);
    if (!textCh) {
      try {
        const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
        if (salasCh && sala.embedMessageId) {
          const msg = await salasCh.messages.fetch(sala.embedMessageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      } catch {}
      fail++;
      continue;
    }

    salas.set(id, sala);

    if (sala.votacao.ativa && sala.votacao.iniciadaEm) {
      if (Date.now() - sala.votacao.iniciadaEm >= VOTE_TIMEOUT_MS) {
        sala.votacao = { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null };
        await textCh.send('\u23F0 Vota\u00e7\u00e3o anterior expirou durante reinicio.').catch(() => {});
      } else {
        iniciarVotacaoTimeout(id, guild);
      }
    }

    await atualizarEmbedPublico(id, guild);
    await atualizarEmbedPrivado(id, guild);
    ok++;
  }

  logger.info(`Restauracao: ${ok} OK, ${fail} descartadas`);
  salvarEstado();
}

// ─────────────────────────────────────────────
//  FAQ INTERATIVO
// ─────────────────────────────────────────────
async function enviarFAQ(guild) {
  const comoFunciona = guild.channels.cache.find(
    c => c.parentId === CUSTOM_CATEGORY_ID && c.name.includes('como-funciona')
  );
  if (!comoFunciona) return;

  // Limpa msgs antigas do bot
  const msgs = await comoFunciona.messages.fetch({ limit: 20 });
  for (const [, m] of msgs) {
    if (m.author.id === client.user.id) await m.delete().catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('\uD83D\uDCDA Como Funciona \u2014 Custom Game')
    .setDescription(
      'Bem-vindo ao sistema de **Custom Game** do Arkheron SA!\n' +
      'Aqui voc\u00ea pode criar e participar de salas de partidas personalizadas.\n\n' +
      '**\uD83D\uDCCB Passo a passo:**\n' +
      '1\uFE0F\u20E3 V\u00e1 ao canal de salas e clique em **"\uD83C\uDFAE Criar Sala"**\n' +
      '2\uFE0F\u20E3 Preencha o nome e o c\u00f3digo do lobby\n' +
      '3\uFE0F\u20E3 Jogadores entram clicando em **"\u2705 Entrar na Sala"**\n' +
      '4\uFE0F\u20E3 O c\u00f3digo aparece no canal privado + DM\n' +
      '5\uFE0F\u20E3 Ao terminar, vote para fechar a sala\n\n' +
      '**\uD83D\uDD14 Notifica\u00e7\u00f5es:**\n' +
      'Ative as notifica\u00e7\u00f5es clicando em **"\uD83D\uDD14 Notifica\u00e7\u00f5es"** no canal de salas.\n' +
      'Voc\u00ea ser\u00e1 mencionado sempre que uma nova sala for criada!\n\n' +
      '**\uD83D\uDCCA Hist\u00f3rico:**\n' +
      'Use o comando `/meuhistorico` para ver suas \u00faltimas partidas e estat\u00edsticas.\n\n' +
      '*Clique nos bot\u00f5es abaixo para saber mais sobre cada funcionalidade.*'
    )
    .setFooter({ text: 'Arkheron SA \u2022 Custom Game' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('faq_criar').setLabel('\uD83C\uDFAE Criar Sala').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq_votacao').setLabel('\uD83D\uDDF3\uFE0F Vota\u00e7\u00e3o').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq_lider').setLabel('\uD83D\uDC51 Lideran\u00e7a').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq_limite').setLabel('\u26A0\uFE0F Limites').setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('faq_codigo').setLabel('\uD83D\uDD11 C\u00f3digo').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq_notificacoes').setLabel('\uD83D\uDD14 Notifica\u00e7\u00f5es').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq_historico').setLabel('\uD83D\uDCCA Hist\u00f3rico').setStyle(ButtonStyle.Primary),
  );

  await comoFunciona.send({ embeds: [embed], components: [row1, row2] });
  logger.info('FAQ interativo enviado');
}

const FAQ_RESPOSTAS = {
  faq_criar: {
    title: '\uD83C\uDFAE Como criar uma sala?',
    desc: '1. V\u00e1 ao canal **#salas** e clique em **"\uD83C\uDFAE Criar Sala"**\n2. Preencha o **nome da sala** e o **c\u00f3digo do lobby**\n3. Um canal privado ser\u00e1 criado automaticamente\n4. Compartilhe para os jogadores entrarem!\n\n*Voc\u00ea precisa ter o cargo \uD83C\uDFAE Jogador ou superior.*',
  },
  faq_votacao: {
    title: '\uD83D\uDDF3\uFE0F Como funciona a vota\u00e7\u00e3o?',
    desc: '1. Qualquer membro clica **"\uD83C\uDFC1 Partida Acabou"**\n2. Uma vota\u00e7\u00e3o \u00e9 iniciada (dura **3 minutos**)\n3. S\u00e3o necess\u00e1rios **60% de votos Sim** para fechar\n4. Se expirar sem quorum, algu\u00e9m pode iniciar outra\n5. O l\u00edder pode cancelar a vota\u00e7\u00e3o ou for\u00e7ar o fechamento',
  },
  faq_lider: {
    title: '\uD83D\uDC51 O que acontece se o l\u00edder sair?',
    desc: 'A lideran\u00e7a \u00e9 **transferida automaticamente** para o membro mais antigo da sala.\n\nO l\u00edder tamb\u00e9m pode transferir manualmente clicando **"\uD83D\uDC51 Transferir L\u00edder"** no canal privado.\n\nA sala s\u00f3 fecha se o **\u00faltimo membro** sair.',
  },
  faq_limite: {
    title: '\u26A0\uFE0F Quais s\u00e3o os limites?',
    desc: '\u2022 **1 sala por membro** — saia da atual para entrar em outra\n\u2022 **1 sala criada por vez** — feche a anterior para criar nova\n\u2022 **Cooldown de 3 min** ap\u00f3s fechar uma sala para criar outra\n\u2022 **Salas expiram** ap\u00f3s 6 horas automaticamente',
  },
  faq_codigo: {
    title: '\uD83D\uDD11 Como mudar o c\u00f3digo do lobby?',
    desc: 'O l\u00edder pode clicar em **"\u270F\uFE0F Alterar C\u00f3digo"** no canal privado a qualquer momento.\n\nUm pop-up vai pedir o novo c\u00f3digo. Todos os membros ser\u00e3o avisados da mudan\u00e7a.',
  },
  faq_notificacoes: {
    title: '\uD83D\uDD14 Como funcionam as notifica\u00e7\u00f5es?',
    desc: 'No canal de salas, clique no bot\u00e3o **"\uD83D\uDD14 Notifica\u00e7\u00f5es"** para ativar ou desativar.\n\n\u2022 **Ativado** \u2014 Voc\u00ea recebe uma men\u00e7\u00e3o sempre que uma nova sala \u00e9 criada\n\u2022 **Desativado** \u2014 Voc\u00ea n\u00e3o \u00e9 mais notificado\n\nO bot adiciona/remove o cargo automaticamente. Clique novamente para alternar.',
  },
  faq_historico: {
    title: '\uD83D\uDCCA Como ver meu hist\u00f3rico?',
    desc: 'Digite **`/meuhistorico`** em qualquer canal do servidor.\n\nO bot mostra:\n\u2022 Suas **\u00faltimas 10 partidas**\n\u2022 Nome da sala, dura\u00e7\u00e3o e quantidade de jogadores\n\u2022 Se voc\u00ea foi l\u00edder (\uD83D\uDC51)\n\u2022 **Total de partidas** e **vezes como l\u00edder**\n\nA resposta \u00e9 vis\u00edvel apenas para voc\u00ea.',
  },
};

// ─────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────
client.once('clientReady', async () => {
  logger.info(`Bot online: ${client.user.tag}`);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { logger.error('Servidor nao encontrado!'); return process.exit(1); }
  const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
  if (!salasCh) { logger.error('Canal de salas nao encontrado!'); return process.exit(1); }

  await restaurarSalas(guild);
  await limparOrfaos(guild);

  // Recria botao "Criar Sala"
  const msgs = await salasCh.messages.fetch({ limit: 20 });
  for (const [, m] of msgs) {
    if (m.author.id === client.user.id && m.components[0]?.components?.some(c => c.customId === 'criar_sala')) {
      await m.delete().catch(() => {});
    }
  }

  const criarEmbed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('\uD83C\uDFAE Custom Game — Salas Ativas')
    .setDescription(
      'Clique no bot\u00e3o abaixo para criar uma sala de custom game.\n' +
      'As salas ativas aparecer\u00e3o aqui em tempo real.\n\n' +
      '*Apenas membros com cargo \uD83C\uDFAE Jogador ou superior podem criar salas.*' +
      (DEBUG ? '\n\n\u26A0\uFE0F **MODO DEBUG ATIVO**' : '')
    )
    .setFooter({ text: 'Arkheron SA \u2022 Custom Game' });

  const criarRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('criar_sala').setLabel('\uD83C\uDFAE Criar Sala').setStyle(ButtonStyle.Primary),
    ...(NOTIFY_ROLE_ID ? [new ButtonBuilder().setCustomId('toggle_notify').setLabel('\uD83D\uDD14 Notifica\u00e7\u00f5es').setStyle(ButtonStyle.Secondary)] : []),
  );

  await salasCh.send({
    embeds: [criarEmbed],
    components: [criarRow],
  });

  // Painel admin
  if (ADMIN_SALAS_CHANNEL_ID) {
    const adminCh = guild.channels.cache.get(ADMIN_SALAS_CHANNEL_ID);
    if (adminCh) {
      const adminMsgs = await adminCh.messages.fetch({ limit: 20 });
      for (const [, m] of adminMsgs) { if (m.author.id === client.user.id) await m.delete().catch(() => {}); }
      await adminCh.send({ embeds: [buildAdminEmbed()], components: buildAdminBotoes() });
    }
  }

  // Registrar slash commands
  try {
    const rest = new REST().setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: [
        {
          name: 'meuhistorico',
          description: 'Veja seu hist\u00f3rico pessoal de partidas custom',
        },
      ],
    });
    logger.info('Slash commands registrados');
  } catch (e) { logger.error(`Erro registrar commands: ${e.message}`); }

  // FAQ interativo
  await enviarFAQ(guild);

  // Auto-cleanup de salas antigas
  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);
    const maxAge = MAX_ROOM_AGE_H * 3600;
    for (const [salaId, sala] of salas) {
      if (!sala.fechando && now - sala.criadoEm > maxAge) {
        logger.info(`Auto-fechando sala antiga ${salaId}`);
        await agendarFechamento(salaId, guild, `timeout (${MAX_ROOM_AGE_H}h+)`);
      }
    }
  }, 30 * 60 * 1000);

  logger.info('Bot inicializado!');
});

// ─────────────────────────────────────────────
//  INTERACOES
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    const guild = interaction.guild;

    // ══════════════════════════════════════════
    //  SLASH COMMAND: /meuhistorico
    // ══════════════════════════════════════════
    if (interaction.isChatInputCommand() && interaction.commandName === 'meuhistorico') {
      const historico = carregarHistoricoUsuario(interaction.user.id, 10);

      if (historico.length === 0) {
        return interaction.reply({ content: '\uD83D\uDCED Voc\u00ea ainda n\u00e3o participou de nenhuma partida registrada.', flags: MessageFlags.Ephemeral });
      }

      const totalPartidas = carregarHistoricoUsuario(interaction.user.id, 200).length;
      const vezesCriador = carregarHistoricoUsuario(interaction.user.id, 200).filter(h => h.criadorId === interaction.user.id).length;

      const lista = historico.reverse().map((h, i) => {
        const duracao = h.fechadoEm && h.criadoEm ? Math.round((h.fechadoEm - h.criadoEm) / 60) : '?';
        const foiLider = h.criadorId === interaction.user.id ? ' \uD83D\uDC51' : '';
        return `**${i + 1}.** \uD83C\uDFAE **${h.nome}**${foiLider}\n   \u2514 ${h.membros} jogadores \u2022 ${duracao} min \u2022 <t:${h.fechadoEm}:d>`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x7B2FBE)
        .setTitle(`\uD83D\uDCCA Hist\u00f3rico de ${interaction.user.displayName}`)
        .setDescription(lista.substring(0, 4000))
        .addFields(
          { name: '\uD83C\uDFAE Total de Partidas', value: `${totalPartidas}`, inline: true },
          { name: '\uD83D\uDC51 Vezes como L\u00edder', value: `${vezesCriador}`, inline: true },
        )
        .setThumbnail(interaction.user.displayAvatarURL())
        .setFooter({ text: 'Arkheron SA \u2022 \u00DAltimas 10 partidas' });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  FAQ
    // ══════════════════════════════════════════
    if (interaction.isButton() && FAQ_RESPOSTAS[interaction.customId]) {
      const faq = FAQ_RESPOSTAS[interaction.customId];
      const embed = new EmbedBuilder().setColor(0x7B2FBE).setTitle(faq.title).setDescription(faq.desc);
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  TOGGLE NOTIFICACOES
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'toggle_notify') {
      if (!NOTIFY_ROLE_ID) return interaction.reply({ content: '\u274C Notifica\u00e7\u00f5es n\u00e3o configuradas.', flags: MessageFlags.Ephemeral });

      const member = interaction.member;
      if (member.roles.cache.has(NOTIFY_ROLE_ID)) {
        await member.roles.remove(NOTIFY_ROLE_ID).catch(() => {});
        return interaction.reply({ content: '\uD83D\uDD15 Notifica\u00e7\u00f5es **desativadas**. Voc\u00ea n\u00e3o ser\u00e1 mais notificado quando novas salas forem criadas.', flags: MessageFlags.Ephemeral });
      } else {
        await member.roles.add(NOTIFY_ROLE_ID).catch(() => {});
        return interaction.reply({ content: '\uD83D\uDD14 Notifica\u00e7\u00f5es **ativadas**! Voc\u00ea ser\u00e1 notificado quando novas salas forem criadas.', flags: MessageFlags.Ephemeral });
      }
    }

    // ══════════════════════════════════════════
    //  CRIAR SALA
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'criar_sala') {
      if (!temCargoMinimo(interaction.member)) {
        return interaction.reply({ content: '\u274C Voc\u00ea precisa do cargo **\uD83C\uDFAE Jogador** ou superior!', flags: MessageFlags.Ephemeral });
      }
      if (salas.size >= MAX_SALAS) {
        return interaction.reply({ content: `\u274C Limite de ${MAX_SALAS} salas atingido!`, flags: MessageFlags.Ephemeral });
      }
      if ([...salas.values()].some(s => s.criadorId === interaction.user.id && !s.fechando)) {
        return interaction.reply({ content: '\u274C Voc\u00ea j\u00e1 tem uma sala ativa!', flags: MessageFlags.Ephemeral });
      }
      // Cooldown
      const lastClose = cooldowns.get(interaction.user.id);
      if (lastClose && Date.now() - lastClose < COOLDOWN_MS) {
        const restante = Math.ceil((COOLDOWN_MS - (Date.now() - lastClose)) / 1000);
        return interaction.reply({ content: `\u23F3 Aguarde **${restante}s** antes de criar outra sala.`, flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder().setCustomId('modal_criar_sala').setTitle('\uD83C\uDFAE Criar Sala de Custom Game');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sala_nome').setLabel('Nome da sala').setStyle(TextInputStyle.Short).setPlaceholder('Ex: Casual iniciantes...').setMaxLength(50).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sala_codigo').setLabel('C\u00f3digo do lobby').setStyle(TextInputStyle.Short).setPlaceholder('Ex: XKZT99').setMaxLength(20).setRequired(true)
        ),
      );
      return interaction.showModal(modal);
    }

    // ══════════════════════════════════════════
    //  MODAL: CRIAR SALA
    // ══════════════════════════════════════════
    if (interaction.isModalSubmit() && interaction.customId === 'modal_criar_sala') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const nome = interaction.fields.getTextInputValue('sala_nome');
      const codigo = interaction.fields.getTextInputValue('sala_codigo');
      const salaId = gerarId();
      const criadorId = interaction.user.id;

      const categoria = guild.channels.cache.get(CUSTOM_CATEGORY_ID);
      if (!categoria) return interaction.editReply({ content: '\u274C Categoria n\u00e3o encontrada!' });

      const textChannel = await guild.channels.create({
        name: `\uD83C\uDFAE\u30FB${nome.toLowerCase().replace(/\s+/g, '-').substring(0, 30)}`,
        type: ChannelType.GuildText,
        parent: categoria.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
          { id: criadorId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
        topic: `Custom Game | L\u00edder: ${interaction.user.username} | C\u00f3digo: ${codigo}`,
      });

      const sala = {
        id: salaId, nome, codigo, vagas: 60, criadorId,
        membros: new Set([criadorId]),
        embedMessageId: null, textChannelId: textChannel.id, privadoMessageId: null,
        criadoEm: Math.floor(Date.now() / 1000),
        votacao: { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null },
        emAndamento: false, fechando: false,
      };
      salas.set(salaId, sala);

      const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
      const notifyContent = NOTIFY_ROLE_ID ? `<@&${NOTIFY_ROLE_ID}> Nova sala criada!` : undefined;
      const embedMsg = await salasCh.send({ content: notifyContent, embeds: [buildSalaEmbed(sala)], components: [buildSalaBotoes(salaId)] });
      sala.embedMessageId = embedMsg.id;

      const privMsg = await textChannel.send({
        content: `<@${criadorId}>`,
        embeds: [buildPrivadoEmbed(sala)],
        components: buildPrivadoBotoes(salaId, false),
      });
      await privMsg.pin();
      sala.privadoMessageId = privMsg.id;

      salvarEstado();
      await logDiscord(guild, `\uD83C\uDFAE Sala **${nome}** criada por <@${criadorId}> | ID: ${salaId}`);
      await interaction.editReply({ content: `\u2705 Sala **${nome}** criada! Acesse: ${textChannel}` });
      await atualizarPainelAdmin(guild).catch(() => {});
      logger.info(`Sala ${salaId} (${nome}) criada. Total: ${salas.size}`);
      return;
    }

    // ══════════════════════════════════════════
    //  MODAL: ALTERAR CODIGO
    // ══════════════════════════════════════════
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_alterar_codigo_')) {
      const salaId = interaction.customId.replace('modal_alterar_codigo_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '\u274C Apenas o l\u00edder.', flags: MessageFlags.Ephemeral });

      const novoCodigo = interaction.fields.getTextInputValue('novo_codigo');
      sala.codigo = novoCodigo;
      salvarEstado();

      await atualizarEmbedPrivado(salaId, guild);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.send(`\uD83D\uDD11 **C\u00f3digo do lobby atualizado** por <@${interaction.user.id}>!\nNovo c\u00f3digo: \`\`\`${novoCodigo}\`\`\``).catch(() => {});

      await interaction.reply({ content: `\u2705 C\u00f3digo alterado para \`${novoCodigo}\``, flags: MessageFlags.Ephemeral });
      logger.info(`Codigo alterado na sala ${salaId}: ${novoCodigo}`);
      return;
    }

    // ══════════════════════════════════════════
    //  ENTRAR NA SALA
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('entrar_')) {
      const salaId = interaction.customId.replace('entrar_', '');
      const sala = salas.get(salaId);

      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada ou fechando.', flags: MessageFlags.Ephemeral });
      if (sala.emAndamento) return interaction.reply({ content: '\u274C Partida em andamento!', flags: MessageFlags.Ephemeral });
      if (sala.membros.size >= sala.vagas) return interaction.reply({ content: '\u274C Sala cheia!', flags: MessageFlags.Ephemeral });
      if (sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voc\u00ea j\u00e1 est\u00e1 nessa sala!', flags: MessageFlags.Ephemeral });

      // Limite: 1 sala por membro
      const jaEstaEmOutra = [...salas.values()].some(s => s.membros.has(interaction.user.id) && s.id !== salaId && !s.fechando);
      if (jaEstaEmOutra) {
        return interaction.reply({ content: '\u274C Voc\u00ea j\u00e1 est\u00e1 em outra sala! Saia dela primeiro.', flags: MessageFlags.Ephemeral });
      }

      sala.membros.add(interaction.user.id);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      if (textCh) await textCh.send(`\u2705 <@${interaction.user.id}> entrou na sala! (${sala.membros.size}/${sala.vagas})`);

      // Notificacao: sala cheia
      if (sala.membros.size >= sala.vagas && textCh) {
        await textCh.send(`\uD83D\uDD34 **Sala cheia!** <@${sala.criadorId}>, todos os ${sala.vagas} jogadores est\u00e3o aqui.`).catch(() => {});
      }

      // DM com codigo do lobby
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(0x7B2FBE)
          .setTitle(`\uD83C\uDFAE ${sala.nome}`)
          .setDescription('Voc\u00ea entrou na sala! Aqui est\u00e1 o c\u00f3digo:')
          .addFields(
            { name: '\uD83D\uDD11 C\u00f3digo do Lobby', value: `\`\`\`${sala.codigo}\`\`\``, inline: false },
            { name: '\uD83D\uDCCD Canal', value: `<#${sala.textChannelId}>`, inline: true },
          )
          .setFooter({ text: 'Arkheron SA \u2022 Custom Game' });
        await interaction.user.send({ embeds: [dmEmbed] });
      } catch {
        // DMs desativadas — segue sem avisar
      }

      salvarEstado();
      await interaction.reply({ content: `\u2705 Voc\u00ea entrou! Acesse: ${textCh}`, flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  SAIR DA SALA (publico)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('sair_') && !interaction.customId.startsWith('sair_privado_')) {
      const salaId = interaction.customId.replace('sair_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.emAndamento) return interaction.reply({ content: '\u274C Partida em andamento!', flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voc\u00ea n\u00e3o est\u00e1 nessa sala.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: '\u2705 Voc\u00ea saiu da sala.', flags: MessageFlags.Ephemeral });
      await removerMembro(salaId, interaction.user.id, guild);
      return;
    }

    // ══════════════════════════════════════════
    //  SAIR DA SALA (privado)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('sair_privado_')) {
      const salaId = interaction.customId.replace('sair_privado_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.emAndamento) return interaction.reply({ content: '\u274C Partida em andamento!', flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voc\u00ea n\u00e3o est\u00e1 nessa sala.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: '\u2705 Voc\u00ea saiu da sala.', flags: MessageFlags.Ephemeral });
      await removerMembro(salaId, interaction.user.id, guild);
      return;
    }

    // ══════════════════════════════════════════
    //  PARTIDA ACABOU (inicia votacao)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('partida_acabou_')) {
      const salaId = interaction.customId.replace('partida_acabou_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voc\u00ea n\u00e3o est\u00e1 nessa sala.', flags: MessageFlags.Ephemeral });
      if (sala.votacao.ativa) return interaction.reply({ content: '\u274C J\u00e1 tem vota\u00e7\u00e3o em andamento!', flags: MessageFlags.Ephemeral });

      sala.votacao = { ativa: true, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: Date.now() };

      const textCh = guild.channels.cache.get(sala.textChannelId);
      const votMsg = await textCh.send({
        content: `@here \uD83D\uDDF3\uFE0F Vota\u00e7\u00e3o iniciada! Voc\u00eas t\u00eam **${Math.floor(VOTE_TIMEOUT_MS / 60000)} minuto(s)** para votar.`,
        embeds: [buildVotacaoEmbed(sala)],
        components: [buildVotacaoBotoes(salaId)],
      });
      sala.votacao.messageId = votMsg.id;
      iniciarVotacaoTimeout(salaId, guild);
      salvarEstado();
      await interaction.reply({ content: '\u2705 Vota\u00e7\u00e3o iniciada!', flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  VOTAR SIM
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('votar_sim_')) {
      const salaId = interaction.customId.replace('votar_sim_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando || !sala.votacao.ativa) return interaction.reply({ content: '\u274C Vota\u00e7\u00e3o n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voc\u00ea n\u00e3o est\u00e1 nessa sala.', flags: MessageFlags.Ephemeral });

      const trocou = sala.votacao.nao.has(interaction.user.id);
      sala.votacao.sim.add(interaction.user.id);
      sala.votacao.nao.delete(interaction.user.id);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && sala.votacao.messageId) {
        const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
        if (votMsg) await votMsg.edit({ embeds: [buildVotacaoEmbed(sala)], components: [buildVotacaoBotoes(salaId)] });
      }

      const precisam = calcularVotosNecessarios(sala.membros.size);
      if (sala.votacao.sim.size >= precisam) {
        cancelarVotacaoTimeout(salaId);
        sala.votacao.ativa = false;
        if (textCh && sala.votacao.messageId) {
          const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
          if (votMsg) await votMsg.edit({ content: '\u2705 Votos suficientes! \uD83C\uDFC1 **A partida acabou!**', embeds: [], components: [] });
        }
        await interaction.reply({ content: '\u2705 Vota\u00e7\u00e3o aprovada! Sala ser\u00e1 fechada.', flags: MessageFlags.Ephemeral });
        await agendarFechamento(salaId, guild, 'vota\u00e7\u00e3o (maioria)');
        return;
      }

      salvarEstado();
      const feedback = trocou
        ? '\u2705 Voto alterado para **Sim**. Pode mudar a qualquer momento.'
        : '\u2705 Voc\u00ea votou **Sim**. Pode mudar para **N\u00e3o** a qualquer momento.';
      await interaction.reply({ content: feedback, flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  VOTAR NAO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('votar_nao_')) {
      const salaId = interaction.customId.replace('votar_nao_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando || !sala.votacao.ativa) return interaction.reply({ content: '\u274C Vota\u00e7\u00e3o n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(interaction.user.id)) return interaction.reply({ content: '\u274C Voc\u00ea n\u00e3o est\u00e1 nessa sala.', flags: MessageFlags.Ephemeral });

      const trocou = sala.votacao.sim.has(interaction.user.id);
      sala.votacao.nao.add(interaction.user.id);
      sala.votacao.sim.delete(interaction.user.id);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && sala.votacao.messageId) {
        const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
        if (votMsg) await votMsg.edit({ embeds: [buildVotacaoEmbed(sala)], components: [buildVotacaoBotoes(salaId)] });
      }

      salvarEstado();
      const feedback = trocou
        ? '\u274C Voto alterado para **N\u00e3o**. Pode mudar a qualquer momento.'
        : '\u274C Voc\u00ea votou **N\u00e3o**. Pode mudar para **Sim** a qualquer momento.';
      await interaction.reply({ content: feedback, flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  CANCELAR VOTACAO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('votar_cancelar_')) {
      const salaId = interaction.customId.replace('votar_cancelar_', '');
      const sala = salas.get(salaId);
      if (!sala || !sala.votacao.ativa) return interaction.reply({ content: '\u274C Nenhuma vota\u00e7\u00e3o ativa.', flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '\u274C Apenas o l\u00edder pode cancelar.', flags: MessageFlags.Ephemeral });

      const oldMsgId = sala.votacao.messageId;
      cancelarVotacaoTimeout(salaId);
      sala.votacao = { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null };

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && oldMsgId) {
        const votMsg = await textCh.messages.fetch(oldMsgId).catch(() => null);
        if (votMsg) await votMsg.edit({ content: '\u23F9\uFE0F **Vota\u00e7\u00e3o cancelada pelo l\u00edder.**', embeds: [], components: [] }).catch(() => {});
      }

      salvarEstado();
      await interaction.reply({ content: '\u2705 Vota\u00e7\u00e3o cancelada.', flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  TOGGLE ANDAMENTO (lider)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('toggle_andamento_')) {
      const salaId = interaction.customId.replace('toggle_andamento_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '\u274C Apenas o l\u00edder.', flags: MessageFlags.Ephemeral });

      sala.emAndamento = !sala.emAndamento;
      const status = sala.emAndamento ? '\uD83D\uDD34 Partida iniciada!' : '\uD83D\uDFE2 Partida pausada!';

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.send(`${status} Por <@${interaction.user.id}>`).catch(() => {});

      salvarEstado();
      await interaction.reply({ content: `\u2705 ${status}`, flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  ALTERAR CODIGO (lider)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('alterar_codigo_')) {
      const salaId = interaction.customId.replace('alterar_codigo_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '\u274C Apenas o l\u00edder.', flags: MessageFlags.Ephemeral });

      const modal = new ModalBuilder()
        .setCustomId(`modal_alterar_codigo_${salaId}`)
        .setTitle('\u270F\uFE0F Alterar C\u00f3digo do Lobby');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('novo_codigo').setLabel('Novo c\u00f3digo do lobby').setStyle(TextInputStyle.Short).setPlaceholder(sala.codigo).setMaxLength(20).setRequired(true)
        ),
      );
      return interaction.showModal(modal);
    }

    // ══════════════════════════════════════════
    //  TRANSFERIR LIDER
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('transferir_lider_')) {
      const salaId = interaction.customId.replace('transferir_lider_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '\u274C Apenas o l\u00edder.', flags: MessageFlags.Ephemeral });

      const membros = [...sala.membros].filter(id => id !== sala.criadorId);
      if (membros.length === 0) return interaction.reply({ content: '\u274C N\u00e3o h\u00e1 outros membros na sala.', flags: MessageFlags.Ephemeral });

      const options = membros.slice(0, 25).map(id => {
        const member = guild.members.cache.get(id);
        return { label: (member?.displayName || `User ${id}`).substring(0, 100), value: id };
      });

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`select_novo_lider_${salaId}`)
          .setPlaceholder('Selecione o novo l\u00edder')
          .addOptions(options)
      );

      return interaction.reply({ content: '\uD83D\uDC51 Selecione o novo l\u00edder:', components: [row], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  SELECT: NOVO LIDER
    // ══════════════════════════════════════════
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_novo_lider_')) {
      const salaId = interaction.customId.replace('select_novo_lider_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.update({ content: '\u274C Sala n\u00e3o encontrada.', components: [] });
      if (sala.criadorId !== interaction.user.id) return interaction.update({ content: '\u274C Voc\u00ea n\u00e3o \u00e9 mais o l\u00edder.', components: [] });

      const novoLiderId = interaction.values[0];
      if (!sala.membros.has(novoLiderId)) return interaction.update({ content: '\u274C Esse membro n\u00e3o est\u00e1 mais na sala.', components: [] });

      sala.criadorId = novoLiderId;
      salvarEstado();

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.send(`\uD83D\uDC51 **Lideran\u00e7a transferida!** <@${interaction.user.id}> \u2192 <@${novoLiderId}>`).catch(() => {});

      await interaction.update({ content: `\u2705 Lideran\u00e7a transferida para <@${novoLiderId}>!`, components: [] });
      logger.info(`Lideranca transferida na sala ${salaId}: ${interaction.user.id} -> ${novoLiderId}`);
      return;
    }

    // ══════════════════════════════════════════
    //  ENCERRAR PARTIDA (lider) — com confirmacao
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('encerrar_partida_')) {
      const salaId = interaction.customId.replace('encerrar_partida_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '\u274C Apenas o l\u00edder.', flags: MessageFlags.Ephemeral });
      return interaction.reply(buildConfirmacao('encerrar', salaId, sala.membros.size));
    }

    // ══════════════════════════════════════════
    //  FORCAR FECHAR (lider) — com confirmacao
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('forcar_fechar_')) {
      const salaId = interaction.customId.replace('forcar_fechar_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== interaction.user.id) return interaction.reply({ content: '\u274C Apenas o l\u00edder.', flags: MessageFlags.Ephemeral });
      return interaction.reply(buildConfirmacao('fechar', salaId, sala.membros.size));
    }

    // ══════════════════════════════════════════
    //  CONFIRMAR ENCERRAR
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('confirmar_encerrar_')) {
      const salaId = interaction.customId.replace('confirmar_encerrar_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.update({ content: '\u274C Sala j\u00e1 est\u00e1 sendo fechada.', embeds: [], components: [] });
      await interaction.update({ content: `\uD83C\uDFC1 Encerrando em ${CLOSE_DELAY_SEC}s...`, embeds: [], components: [] });
      await agendarFechamento(salaId, guild, `encerrada pelo l\u00edder (<@${interaction.user.id}>)`);
      return;
    }

    // ══════════════════════════════════════════
    //  CONFIRMAR FECHAR
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('confirmar_fechar_')) {
      const salaId = interaction.customId.replace('confirmar_fechar_', '');
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.update({ content: '\u274C Sala j\u00e1 est\u00e1 sendo fechada.', embeds: [], components: [] });
      await interaction.update({ content: `\uD83D\uDDD1\uFE0F Fechando em ${CLOSE_DELAY_SEC}s...`, embeds: [], components: [] });
      await agendarFechamento(salaId, guild, `criador (<@${interaction.user.id}>)`);
      return;
    }

    // ══════════════════════════════════════════
    //  CANCELAR ACAO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('cancelar_acao_')) {
      return interaction.update({ content: '\u274C A\u00e7\u00e3o cancelada.', embeds: [], components: [] });
    }

    // ══════════════════════════════════════════
    //  ADMIN: REFRESH
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_refresh') {
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: '\u274C Sem permiss\u00e3o.', flags: MessageFlags.Ephemeral });
      await atualizarPainelAdmin(guild);
      return interaction.reply({ content: '\u2705 Atualizado!', flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  ADMIN: FECHAR TODAS
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_delete_all') {
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: '\u274C Sem permiss\u00e3o.', flags: MessageFlags.Ephemeral });
      const ids = Array.from(salas.keys()).filter(id => !salas.get(id).fechando);
      if (ids.length === 0) return interaction.reply({ content: '\u274C Nenhuma sala ativa.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: `\uD83D\uDDD1\uFE0F Fechando ${ids.length} sala(s)...`, flags: MessageFlags.Ephemeral });
      for (const id of ids) await agendarFechamento(id, guild, `admin (<@${interaction.user.id}>)`);
      return;
    }

    // ══════════════════════════════════════════
    //  ADMIN: LIMPAR ORFAOS
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_cleanup_orfaos') {
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: '\u274C Sem permiss\u00e3o.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const n = await limparOrfaos(guild);
      return interaction.editReply({ content: `\uD83E\uDDF9 **${n}** \u00f3rf\u00e3o(s) removido(s).` });
    }

    // ══════════════════════════════════════════
    //  ADMIN: HISTORICO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_historico') {
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: '\u274C Sem permiss\u00e3o.', flags: MessageFlags.Ephemeral });

      const historico = carregarHistorico(10);
      if (historico.length === 0) {
        return interaction.reply({ content: '\uD83D\uDCCA Nenhum registro no hist\u00f3rico.', flags: MessageFlags.Ephemeral });
      }

      const lista = historico.reverse().map((h, i) => {
        const duracao = h.fechadoEm && h.criadoEm ? Math.round((h.fechadoEm - h.criadoEm) / 60) : '?';
        return `**${i + 1}.** \uD83C\uDFAE **${h.nome}** — ${h.membros} jogadores — ${duracao} min\n   \u2514 L\u00edder: <@${h.criadorId}> | Motivo: ${h.motivo}`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x7B2FBE)
        .setTitle('\uD83D\uDCCA Hist\u00f3rico — \u00DAltimas 10 Partidas')
        .setDescription(lista.substring(0, 4000))
        .setFooter({ text: `Total registrado: ${carregarHistorico(200).length} partida(s)` });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  ADMIN: SELECT SALA
    // ══════════════════════════════════════════
    if (interaction.isStringSelectMenu() && interaction.customId === 'admin_select_sala') {
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: '\u274C Sem permiss\u00e3o.', flags: MessageFlags.Ephemeral });
      const salaId = interaction.values[0];
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: '\u274C Sala n\u00e3o encontrada.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: `\uD83D\uDDD1\uFE0F Fechando **${sala.nome}**...`, flags: MessageFlags.Ephemeral });
      await agendarFechamento(salaId, guild, `admin (<@${interaction.user.id}>)`);
      return;
    }

  } catch (error) {
    logger.error(`Erro interacao ${interaction?.customId || 'desconhecida'}: ${error.stack || error.message}`);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '\u274C Erro interno. Tente novamente.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.followUp({ content: '\u274C Erro interno. Tente novamente.', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

// ─────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
async function gracefulShutdown(signal) {
  logger.info(`${signal} recebido — shutdown...`);
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      for (const [, sala] of salas) {
        if (sala.fechando) continue;
        const ch = guild.channels.cache.get(sala.textChannelId);
        if (ch) await ch.send('\u26A0\uFE0F **Bot reiniciando.** Salas ser\u00e3o restauradas automaticamente.').catch(() => {});
      }
    }
    salvarEstado();
    for (const [id] of voteTimeouts) cancelarVotacaoTimeout(id);
    client.destroy();
  } catch (e) { logger.error(`Erro shutdown: ${e.message}`); }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─────────────────────────────────────────────
//  ERROS GLOBAIS
// ─────────────────────────────────────────────
client.on('error', e => logger.error(`Client Error: ${e.stack || e.message}`));
process.on('unhandledRejection', e => logger.error(`Unhandled Rejection: ${e?.stack || e}`));
process.on('uncaughtException', e => { logger.error(`FATAL: ${e.stack || e.message}`); salvarEstado(); process.exit(1); });

// ─────────────────────────────────────────────
//  LOGIN
// ─────────────────────────────────────────────
client.login(DISCORD_TOKEN).catch(e => { logger.error(`Token invalido: ${e.message}`); process.exit(1); });
