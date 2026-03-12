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
  CLASSES_CATEGORY_ID,
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
//  SISTEMA DE IDIOMAS (i18n)
// ─────────────────────────────────────────────
const IDIOMAS_FILE = path.join(__dirname, 'idiomas.json');
const userLang = new Map(); // userId -> 'pt-BR' | 'es'

const TRADUCOES = {
  'pt-BR': {
    // Botões de sala
    btn_entrar: '✅ Entrar na Sala',
    btn_sair: '🚪 Sair da Sala',
    btn_partida_acabou: '🏁 Partida Acabou',
    btn_sair_privado: '🚪 Sair da Sala',
    btn_iniciar_partida: '▶️ Iniciar Partida',
    btn_pausar_partida: '⏸️ Pausar Partida',
    btn_alterar_codigo: '✏️ Alterar Código',
    btn_transferir_lider: '👑 Transferir Líder',
    btn_encerrar_partida: '🏁 Encerrar Partida',
    btn_fechar_sala: '🗑️ Fechar Sala',
    btn_criar_sala: '🎮 Criar Sala',
    btn_notificacoes: '🔔 Notificações',
    btn_confirmar: '✅ Confirmar',
    btn_cancelar: '❌ Cancelar',

    // Botões de votação
    btn_votar_sim: '✅ Sim, acabou',
    btn_votar_nao: '❌ Não acabou',
    btn_cancelar_votacao: '⏹️ Cancelar Votação',

    // Botões FAQ
    btn_faq_criar: '🎮 Criar Sala',
    btn_faq_votacao: '🗳️ Votação',
    btn_faq_lider: '👑 Liderança',
    btn_faq_limite: '⚠️ Limites',
    btn_faq_codigo: '🔑 Código',
    btn_faq_notificacoes: '🔔 Notificações',
    btn_faq_historico: '📊 Histórico',

    // Botões Admin
    btn_admin_refresh: '🔄 Atualizar',
    btn_admin_delete_all: '🗑️ Fechar Todas',
    btn_admin_cleanup: '🧹 Limpar Órfãos',
    btn_admin_historico: '📋 Histórico',

    // Status da sala
    status_esperando: '🟢 Esperando jogadores',
    status_andamento: '🔴 Partida em andamento',
    status_fechando: '🟡 Fechando...',
    status_sala_cheia: '🔴 Sala cheia',
    status_aceitando: '🟢 Aceitando jogadores',

    // Embeds - Títulos
    embed_sala_titulo: '🎮 {nome}',
    embed_sala_privado_titulo: '🎮 {nome} — Canal Privado',
    embed_sala_privado_desc: 'Bem-vindo! O código do lobby e a lista de participantes estão abaixo.\n*Botões de gerenciamento são exclusivos do líder.*',
    embed_votacao_titulo: '⚔️ Votação — A partida acabou?',
    embed_confirmacao_titulo: '⚠️ Confirmação Necessária',
    embed_admin_titulo: '🛡️ Painel de Administração — Salas Ativas',
    embed_faq_titulo: '📚 Como Funciona — Custom Game',
    embed_classes_titulo: '📖 Classes — Arkheron',
    embed_historico_titulo: '📊 Histórico de {nome}',
    embed_historico_admin_titulo: '📊 Histórico — Últimas 10 Partidas',
    embed_criar_titulo: '🎮 Custom Game — Salas Ativas',

    // Embeds - Fields
    field_status: '📊 Status',
    field_lider: '👑 Líder',
    field_criada: '⏱️ Criada',
    field_vagas: '👥 Vagas',
    field_codigo: '🔑 Código do Lobby',
    field_participantes: '👥 Participantes',
    field_membros: '📋 Membros',
    field_votos_sim: '✅ Sim',
    field_votos_nao: '❌ Não',
    field_votos_total: '📊 Total',
    field_para_fechar: '⚠️ Para fechar',
    field_total_partidas: '🎮 Total de Partidas',
    field_vezes_lider: '👑 Vezes como Líder',
    field_equipamentos: '🎮 Equipamentos',

    // Embeds - Descrições
    embed_criar_desc: 'Clique no botão abaixo para criar uma sala de custom game.\nAs salas ativas aparecerão aqui em tempo real.\n\n*Apenas membros com cargo 🎮 Jogador ou superior podem criar salas.*',
    embed_faq_desc: 'Bem-vindo ao sistema de **Custom Game** do Arkheron SA!\nAqui você pode criar e participar de salas de partidas personalizadas.\n\n**📋 Passo a passo:**\n1️⃣ Vá ao canal de salas e clique em **"🎮 Criar Sala"**\n2️⃣ Preencha o nome e o código do lobby\n3️⃣ Jogadores entram clicando em **"✅ Entrar na Sala"**\n4️⃣ O código aparece no canal privado + DM\n5️⃣ Ao terminar, vote para fechar a sala\n\n**🔔 Notificações:**\nAtive as notificações clicando em **"🔔 Notificações"** no canal de salas.\nVocê será mencionado sempre que uma nova sala for criada!\n\n**📊 Histórico:**\nUse o comando `/meuhistorico` para ver suas últimas partidas e estatísticas.\n\n*Clique nos botões abaixo para saber mais sobre cada funcionalidade.*',
    embed_classes_desc: 'Conheça todas as classes disponíveis no jogo!\nSelecione uma classe no menu abaixo para ver os **equipamentos e habilidades**.\n\n{lista}',
    embed_admin_nenhuma: '📭 Nenhuma sala ativa.',
    embed_admin_ativas: '🎮 **{count} sala(s) ativa(s)**',

    // Mensagens de chat
    msg_sala_fechando: '🏁 **A sala será fechada em {segundos} segundos...** ({motivo})',
    msg_ultimo_saiu: '👤 Último membro saiu. Sala será fechada...',
    msg_lider_saiu: '👑 **O líder saiu.** Liderança transferida automaticamente para <@{novo}>!',
    msg_membro_saiu: '🚪 <@{user}> saiu da sala. ({atual}/{total})',
    msg_votacao_expirou: '⏰ Votação anterior expirou durante reinicio.',
    msg_membro_entrou: '✅ <@{user}> entrou na sala! ({atual}/{total})',
    msg_sala_cheia: '🔴 **Sala cheia!** <@{lider}>, todos os {total} jogadores estão aqui.',
    msg_codigo_atualizado: '🔑 **Código do lobby atualizado** por <@{user}>!\nNovo código: ```{codigo}```',
    msg_votacao_iniciada: '@here 🗳️ Votação iniciada! Vocês têm **{minutos} minuto(s)** para votar.',
    msg_votacao_aprovada: '✅ Votos suficientes! 🏁 **A partida acabou!**',
    msg_votacao_cancelada: '⏹️ **Votação cancelada pelo líder.**',
    msg_votacao_expirou_chat: '⏰ **Votação expirou!** Alguém pode iniciar uma nova.',
    msg_partida_iniciada: '🔴 Partida iniciada!',
    msg_partida_pausada: '🟢 Partida pausada!',
    msg_lideranca_transferida: '👑 **Liderança transferida!** <@{de}> → <@{para}>',
    msg_bot_reiniciando: '⚠️ **Bot reiniciando.** Salas serão restauradas automaticamente.',

    // Respostas efêmeras
    resp_sem_cargo: '❌ Você precisa do cargo **🎮 Jogador** ou superior!',
    resp_limite_salas: '❌ Limite de {max} salas atingido!',
    resp_ja_tem_sala: '❌ Você já tem uma sala ativa!',
    resp_cooldown: '⏳ Aguarde **{segundos}s** antes de criar outra sala.',
    resp_categoria_erro: '❌ Categoria não encontrada!',
    resp_sala_criada: '✅ Sala **{nome}** criada! Acesse: {canal}',
    resp_sala_nao_encontrada: '❌ Sala não encontrada.',
    resp_sala_fechando: '❌ Sala não encontrada ou fechando.',
    resp_apenas_lider: '❌ Apenas o líder.',
    resp_codigo_alterado: '✅ Código alterado para `{codigo}`',
    resp_partida_andamento: '❌ Partida em andamento!',
    resp_sala_cheia: '❌ Sala cheia!',
    resp_ja_na_sala: '❌ Você já está nessa sala!',
    resp_em_outra_sala: '❌ Você já está em outra sala! Saia dela primeiro.',
    resp_voce_entrou: '✅ Você entrou! Acesse: {canal}',
    resp_nao_na_sala: '❌ Você não está nessa sala.',
    resp_voce_saiu: '✅ Você saiu da sala.',
    resp_votacao_andamento: '❌ Já tem votação em andamento!',
    resp_votacao_iniciada: '✅ Votação iniciada!',
    resp_votacao_nao_encontrada: '❌ Votação não encontrada.',
    resp_voto_sim: '✅ Você votou **Sim**. Pode mudar para **Não** a qualquer momento.',
    resp_voto_sim_trocou: '✅ Voto alterado para **Sim**. Pode mudar a qualquer momento.',
    resp_voto_nao: '❌ Você votou **Não**. Pode mudar para **Sim** a qualquer momento.',
    resp_voto_nao_trocou: '❌ Voto alterado para **Não**. Pode mudar a qualquer momento.',
    resp_votacao_aprovada: '✅ Votação aprovada! Sala será fechada.',
    resp_nenhuma_votacao: '❌ Nenhuma votação ativa.',
    resp_apenas_lider_cancelar: '❌ Apenas o líder pode cancelar.',
    resp_votacao_cancelada: '✅ Votação cancelada.',
    resp_sem_outros_membros: '❌ Não há outros membros na sala.',
    resp_selecione_lider: '👑 Selecione o novo líder:',
    resp_nao_mais_lider: '❌ Você não é mais o líder.',
    resp_membro_saiu_select: '❌ Esse membro não está mais na sala.',
    resp_lideranca_transferida: '✅ Liderança transferida para <@{user}>!',
    resp_sala_sendo_fechada: '❌ Sala já está sendo fechada.',
    resp_encerrando: '🏁 Encerrando em {segundos}s...',
    resp_fechando: '🗑️ Fechando em {segundos}s...',
    resp_acao_cancelada: '❌ Ação cancelada.',
    resp_sem_permissao: '❌ Sem permissão.',
    resp_atualizado: '✅ Atualizado!',
    resp_nenhuma_sala_ativa: '❌ Nenhuma sala ativa.',
    resp_fechando_salas: '🗑️ Fechando {count} sala(s)...',
    resp_orfaos_removidos: '🧹 **{count}** órfão(s) removido(s).',
    resp_sem_historico: '📭 Você ainda não participou de nenhuma partida registrada.',
    resp_sem_historico_admin: '📊 Nenhum registro no histórico.',
    resp_notify_desativadas: '🔕 Notificações **desativadas**. Você não será mais notificado quando novas salas forem criadas.',
    resp_notify_ativadas: '🔔 Notificações **ativadas**! Você será notificado quando novas salas forem criadas.',
    resp_notify_erro: '❌ Notificações não configuradas.',
    resp_classe_nao_encontrada: '❌ Classe não encontrada.',
    resp_erro_interno: '❌ Erro interno. Tente novamente.',

    // Confirmação
    confirm_encerrar_desc: 'Tem certeza que deseja **encerrar a partida**?\nIsso afetará **{membros}** jogador(es). A sala será fechada após {segundos}s.',
    confirm_fechar_desc: 'Tem certeza que deseja **fechar a sala**?\nIsso removerá **{membros}** jogador(es) e deletará o canal.',

    // Votação
    votacao_faltam: 'Faltam **{faltam}** votos em Sim',
    votacao_suficientes: '✅ Votos suficientes!',
    votacao_footer: 'Mínimo: {min} votos Sim | Expira em {min_rest}m{sec_rest}s',

    // Modal
    modal_criar_titulo: '🎮 Criar Sala de Custom Game',
    modal_criar_nome: 'Nome da sala',
    modal_criar_nome_placeholder: 'Ex: Casual iniciantes...',
    modal_criar_codigo: 'Código do lobby',
    modal_criar_codigo_placeholder: 'Ex: XKZT99',
    modal_alterar_titulo: '✏️ Alterar Código do Lobby',
    modal_alterar_codigo: 'Novo código do lobby',

    // DM
    dm_titulo: '🎮 {nome}',
    dm_desc: 'Você entrou na sala! Aqui está o código:',
    dm_canal: '📍 Canal',

    // Select menus
    select_sala_placeholder: 'Selecione uma sala para deletar',
    select_lider_placeholder: 'Selecione o novo líder',
    select_classe_placeholder: '🔍 Selecione uma classe...',

    // FAQ Respostas
    faq_criar_titulo: '🎮 Como criar uma sala?',
    faq_criar_desc: '1. Vá ao canal **#salas** e clique em **"🎮 Criar Sala"**\n2. Preencha o **nome da sala** e o **código do lobby**\n3. Um canal privado será criado automaticamente\n4. Compartilhe para os jogadores entrarem!\n\n*Você precisa ter o cargo 🎮 Jogador ou superior.*',
    faq_votacao_titulo: '🗳️ Como funciona a votação?',
    faq_votacao_desc: '1. Qualquer membro clica **"🏁 Partida Acabou"**\n2. Uma votação é iniciada (dura **3 minutos**)\n3. São necessários **60% de votos Sim** para fechar\n4. Se expirar sem quorum, alguém pode iniciar outra\n5. O líder pode cancelar a votação ou forçar o fechamento',
    faq_lider_titulo: '👑 O que acontece se o líder sair?',
    faq_lider_desc: 'A liderança é **transferida automaticamente** para o membro mais antigo da sala.\n\nO líder também pode transferir manualmente clicando **"👑 Transferir Líder"** no canal privado.\n\nA sala só fecha se o **último membro** sair.',
    faq_limite_titulo: '⚠️ Quais são os limites?',
    faq_limite_desc: '• **1 sala por membro** — saia da atual para entrar em outra\n• **1 sala criada por vez** — feche a anterior para criar nova\n• **Cooldown de 3 min** após fechar uma sala para criar outra\n• **Salas expiram** após 6 horas automaticamente',
    faq_codigo_titulo: '🔑 Como mudar o código do lobby?',
    faq_codigo_desc: 'O líder pode clicar em **"✏️ Alterar Código"** no canal privado a qualquer momento.\n\nUm pop-up vai pedir o novo código. Todos os membros serão avisados da mudança.',
    faq_notificacoes_titulo: '🔔 Como funcionam as notificações?',
    faq_notificacoes_desc: 'No canal de salas, clique no botão **"🔔 Notificações"** para ativar ou desativar.\n\n• **Ativado** — Você recebe uma menção sempre que uma nova sala é criada\n• **Desativado** — Você não é mais notificado\n\nO bot adiciona/remove o cargo automaticamente. Clique novamente para alternar.',
    faq_historico_titulo: '📊 Como ver meu histórico?',
    faq_historico_desc: 'Digite **`/meuhistorico`** em qualquer canal do servidor.\n\nO bot mostra:\n• Suas **últimas 10 partidas**\n• Nome da sala, duração e quantidade de jogadores\n• Se você foi líder (👑)\n• **Total de partidas** e **vezes como líder**\n\nA resposta é visível apenas para você.',

    // Histórico
    historico_footer: 'Arkheron SA • Últimas 10 partidas',
    historico_footer_admin: 'Total registrado: {total} partida(s)',

    // Outros
    nenhum_membro: '*Nenhum membro*',
    e_mais: '*...e mais {count} jogador(es)*',
    boa_partida: 'Boa partida!',
    modo_debug: '\n\n⚠️ **MODO DEBUG ATIVO**',
    footer_arkheron: 'Arkheron SA • Custom Game',
    footer_classes: 'Arkheron SA • Guia de Classes',
    footer_classes_menu: 'Arkheron SA • Guia de Classes • Use o menu para ver outra classe',
    bonus_classe: '🏆 **Bônus de Classe:** {bonus}',
    equipamentos_desc: '👑 **Coroa** (Slot 1) • 💮 **Amuleto** (Slot 2) • ⚔️ **Arma 1** (Slot 3) • 🗡️ **Arma 2** (Slot 4)',
    slot_coroa: '👑 Coroa (Slot 1)',
    slot_amuleto: '💮 Amuleto (Slot 2)',
    slot_arma1: '⚔️ Arma 1 (Slot 3)',
    slot_arma2: '🗡️ Arma 2 (Slot 4)',
    votos: 'votos',

    // Idioma
    idioma_mudou_es: '🌐 Idioma cambiado a **Español**. Todas las interacciones del bot ahora serán en español.',
    idioma_mudou_pt: '🌐 Idioma alterado para **Português**. Todas as interações do bot agora serão em português.',
    btn_mudar_idioma: '🌐 Español',
  },

  'es': {
    // Botões de sala
    btn_entrar: '✅ Entrar a la Sala',
    btn_sair: '🚪 Salir de la Sala',
    btn_partida_acabou: '🏁 Partida Terminó',
    btn_sair_privado: '🚪 Salir de la Sala',
    btn_iniciar_partida: '▶️ Iniciar Partida',
    btn_pausar_partida: '⏸️ Pausar Partida',
    btn_alterar_codigo: '✏️ Cambiar Código',
    btn_transferir_lider: '👑 Transferir Líder',
    btn_encerrar_partida: '🏁 Terminar Partida',
    btn_fechar_sala: '🗑️ Cerrar Sala',
    btn_criar_sala: '🎮 Crear Sala',
    btn_notificacoes: '🔔 Notificaciones',
    btn_confirmar: '✅ Confirmar',
    btn_cancelar: '❌ Cancelar',

    // Botões de votação
    btn_votar_sim: '✅ Sí, terminó',
    btn_votar_nao: '❌ No terminó',
    btn_cancelar_votacao: '⏹️ Cancelar Votación',

    // Botões FAQ
    btn_faq_criar: '🎮 Crear Sala',
    btn_faq_votacao: '🗳️ Votación',
    btn_faq_lider: '👑 Liderazgo',
    btn_faq_limite: '⚠️ Límites',
    btn_faq_codigo: '🔑 Código',
    btn_faq_notificacoes: '🔔 Notificaciones',
    btn_faq_historico: '📊 Historial',

    // Botões Admin
    btn_admin_refresh: '🔄 Actualizar',
    btn_admin_delete_all: '🗑️ Cerrar Todas',
    btn_admin_cleanup: '🧹 Limpiar Huérfanos',
    btn_admin_historico: '📋 Historial',

    // Status da sala
    status_esperando: '🟢 Esperando jugadores',
    status_andamento: '🔴 Partida en curso',
    status_fechando: '🟡 Cerrando...',
    status_sala_cheia: '🔴 Sala llena',
    status_aceitando: '🟢 Aceptando jugadores',

    // Embeds - Títulos
    embed_sala_titulo: '🎮 {nome}',
    embed_sala_privado_titulo: '🎮 {nome} — Canal Privado',
    embed_sala_privado_desc: '¡Bienvenido! El código del lobby y la lista de participantes están abajo.\n*Los botones de gestión son exclusivos del líder.*',
    embed_votacao_titulo: '⚔️ Votación — ¿Terminó la partida?',
    embed_confirmacao_titulo: '⚠️ Confirmación Necesaria',
    embed_admin_titulo: '🛡️ Panel de Administración — Salas Activas',
    embed_faq_titulo: '📚 Cómo Funciona — Custom Game',
    embed_classes_titulo: '📖 Clases — Arkheron',
    embed_historico_titulo: '📊 Historial de {nome}',
    embed_historico_admin_titulo: '📊 Historial — Últimas 10 Partidas',
    embed_criar_titulo: '🎮 Custom Game — Salas Activas',

    // Embeds - Fields
    field_status: '📊 Estado',
    field_lider: '👑 Líder',
    field_criada: '⏱️ Creada',
    field_vagas: '👥 Plazas',
    field_codigo: '🔑 Código del Lobby',
    field_participantes: '👥 Participantes',
    field_membros: '📋 Miembros',
    field_votos_sim: '✅ Sí',
    field_votos_nao: '❌ No',
    field_votos_total: '📊 Total',
    field_para_fechar: '⚠️ Para cerrar',
    field_total_partidas: '🎮 Total de Partidas',
    field_vezes_lider: '👑 Veces como Líder',
    field_equipamentos: '🎮 Equipamientos',

    // Embeds - Descrições
    embed_criar_desc: 'Haz clic en el botón para crear una sala de custom game.\nLas salas activas aparecerán aquí en tiempo real.\n\n*Solo miembros con rol 🎮 Jugador o superior pueden crear salas.*',
    embed_faq_desc: '¡Bienvenido al sistema de **Custom Game** de Arkheron SA!\nAquí puedes crear y participar en salas de partidas personalizadas.\n\n**📋 Paso a paso:**\n1️⃣ Ve al canal de salas y haz clic en **"🎮 Crear Sala"**\n2️⃣ Completa el nombre y el código del lobby\n3️⃣ Los jugadores entran haciendo clic en **"✅ Entrar a la Sala"**\n4️⃣ El código aparece en el canal privado + DM\n5️⃣ Al terminar, vota para cerrar la sala\n\n**🔔 Notificaciones:**\nActiva las notificaciones haciendo clic en **"🔔 Notificaciones"** en el canal de salas.\n¡Serás mencionado cada vez que se cree una nueva sala!\n\n**📊 Historial:**\nUsa el comando `/meuhistorico` para ver tus últimas partidas y estadísticas.\n\n*Haz clic en los botones para saber más sobre cada función.*',
    embed_classes_desc: '¡Conoce todas las clases disponibles en el juego!\nSelecciona una clase en el menú para ver los **equipamientos y habilidades**.\n\n{lista}',
    embed_admin_nenhuma: '📭 Ninguna sala activa.',
    embed_admin_ativas: '🎮 **{count} sala(s) activa(s)**',

    // Mensagens de chat
    msg_sala_fechando: '🏁 **La sala se cerrará en {segundos} segundos...** ({motivo})',
    msg_ultimo_saiu: '👤 Último miembro salió. La sala se cerrará...',
    msg_lider_saiu: '👑 **El líder salió.** Liderazgo transferido automáticamente a <@{novo}>!',
    msg_membro_saiu: '🚪 <@{user}> salió de la sala. ({atual}/{total})',
    msg_votacao_expirou: '⏰ Votación anterior expiró durante reinicio.',
    msg_membro_entrou: '✅ <@{user}> entró a la sala! ({atual}/{total})',
    msg_sala_cheia: '🔴 **¡Sala llena!** <@{lider}>, todos los {total} jugadores están aquí.',
    msg_codigo_atualizado: '🔑 **Código del lobby actualizado** por <@{user}>!\nNuevo código: ```{codigo}```',
    msg_votacao_iniciada: '@here 🗳️ ¡Votación iniciada! Tienen **{minutos} minuto(s)** para votar.',
    msg_votacao_aprovada: '✅ ¡Votos suficientes! 🏁 **¡La partida terminó!**',
    msg_votacao_cancelada: '⏹️ **Votación cancelada por el líder.**',
    msg_votacao_expirou_chat: '⏰ **¡Votación expiró!** Alguien puede iniciar una nueva.',
    msg_partida_iniciada: '🔴 ¡Partida iniciada!',
    msg_partida_pausada: '🟢 ¡Partida pausada!',
    msg_lideranca_transferida: '👑 **¡Liderazgo transferido!** <@{de}> → <@{para}>',
    msg_bot_reiniciando: '⚠️ **Bot reiniciando.** Las salas se restaurarán automáticamente.',

    // Respostas efêmeras
    resp_sem_cargo: '❌ ¡Necesitas el rol **🎮 Jugador** o superior!',
    resp_limite_salas: '❌ ¡Límite de {max} salas alcanzado!',
    resp_ja_tem_sala: '❌ ¡Ya tienes una sala activa!',
    resp_cooldown: '⏳ Espera **{segundos}s** antes de crear otra sala.',
    resp_categoria_erro: '❌ ¡Categoría no encontrada!',
    resp_sala_criada: '✅ ¡Sala **{nome}** creada! Accede: {canal}',
    resp_sala_nao_encontrada: '❌ Sala no encontrada.',
    resp_sala_fechando: '❌ Sala no encontrada o cerrando.',
    resp_apenas_lider: '❌ Solo el líder.',
    resp_codigo_alterado: '✅ Código cambiado a `{codigo}`',
    resp_partida_andamento: '❌ ¡Partida en curso!',
    resp_sala_cheia: '❌ ¡Sala llena!',
    resp_ja_na_sala: '❌ ¡Ya estás en esta sala!',
    resp_em_outra_sala: '❌ ¡Ya estás en otra sala! Sal de ella primero.',
    resp_voce_entrou: '✅ ¡Entraste! Accede: {canal}',
    resp_nao_na_sala: '❌ No estás en esta sala.',
    resp_voce_saiu: '✅ Saliste de la sala.',
    resp_votacao_andamento: '❌ ¡Ya hay una votación en curso!',
    resp_votacao_iniciada: '✅ ¡Votación iniciada!',
    resp_votacao_nao_encontrada: '❌ Votación no encontrada.',
    resp_voto_sim: '✅ Votaste **Sí**. Puedes cambiar a **No** en cualquier momento.',
    resp_voto_sim_trocou: '✅ Voto cambiado a **Sí**. Puedes cambiarlo en cualquier momento.',
    resp_voto_nao: '❌ Votaste **No**. Puedes cambiar a **Sí** en cualquier momento.',
    resp_voto_nao_trocou: '❌ Voto cambiado a **No**. Puedes cambiarlo en cualquier momento.',
    resp_votacao_aprovada: '✅ ¡Votación aprobada! La sala se cerrará.',
    resp_nenhuma_votacao: '❌ Ninguna votación activa.',
    resp_apenas_lider_cancelar: '❌ Solo el líder puede cancelar.',
    resp_votacao_cancelada: '✅ Votación cancelada.',
    resp_sem_outros_membros: '❌ No hay otros miembros en la sala.',
    resp_selecione_lider: '👑 Selecciona el nuevo líder:',
    resp_nao_mais_lider: '❌ Ya no eres el líder.',
    resp_membro_saiu_select: '❌ Ese miembro ya no está en la sala.',
    resp_lideranca_transferida: '✅ ¡Liderazgo transferido a <@{user}>!',
    resp_sala_sendo_fechada: '❌ La sala ya se está cerrando.',
    resp_encerrando: '🏁 Cerrando en {segundos}s...',
    resp_fechando: '🗑️ Cerrando en {segundos}s...',
    resp_acao_cancelada: '❌ Acción cancelada.',
    resp_sem_permissao: '❌ Sin permiso.',
    resp_atualizado: '✅ ¡Actualizado!',
    resp_nenhuma_sala_ativa: '❌ Ninguna sala activa.',
    resp_fechando_salas: '🗑️ Cerrando {count} sala(s)...',
    resp_orfaos_removidos: '🧹 **{count}** huérfano(s) eliminado(s).',
    resp_sem_historico: '📭 Aún no has participado en ninguna partida registrada.',
    resp_sem_historico_admin: '📊 Ningún registro en el historial.',
    resp_notify_desativadas: '🔕 Notificaciones **desactivadas**. Ya no serás notificado cuando se creen nuevas salas.',
    resp_notify_ativadas: '🔔 ¡Notificaciones **activadas**! Serás notificado cuando se creen nuevas salas.',
    resp_notify_erro: '❌ Notificaciones no configuradas.',
    resp_classe_nao_encontrada: '❌ Clase no encontrada.',
    resp_erro_interno: '❌ Error interno. Inténtalo de nuevo.',

    // Confirmação
    confirm_encerrar_desc: '¿Estás seguro de que deseas **terminar la partida**?\nEsto afectará a **{membros}** jugador(es). La sala se cerrará después de {segundos}s.',
    confirm_fechar_desc: '¿Estás seguro de que deseas **cerrar la sala**?\nEsto eliminará a **{membros}** jugador(es) y borrará el canal.',

    // Votação
    votacao_faltam: 'Faltan **{faltam}** votos en Sí',
    votacao_suficientes: '✅ ¡Votos suficientes!',
    votacao_footer: 'Mínimo: {min} votos Sí | Expira en {min_rest}m{sec_rest}s',

    // Modal
    modal_criar_titulo: '🎮 Crear Sala de Custom Game',
    modal_criar_nome: 'Nombre de la sala',
    modal_criar_nome_placeholder: 'Ej: Casual principiantes...',
    modal_criar_codigo: 'Código del lobby',
    modal_criar_codigo_placeholder: 'Ej: XKZT99',
    modal_alterar_titulo: '✏️ Cambiar Código del Lobby',
    modal_alterar_codigo: 'Nuevo código del lobby',

    // DM
    dm_titulo: '🎮 {nome}',
    dm_desc: '¡Entraste a la sala! Aquí está el código:',
    dm_canal: '📍 Canal',

    // Select menus
    select_sala_placeholder: 'Selecciona una sala para eliminar',
    select_lider_placeholder: 'Selecciona el nuevo líder',
    select_classe_placeholder: '🔍 Selecciona una clase...',

    // FAQ Respostas
    faq_criar_titulo: '🎮 ¿Cómo crear una sala?',
    faq_criar_desc: '1. Ve al canal **#salas** y haz clic en **"🎮 Crear Sala"**\n2. Completa el **nombre de la sala** y el **código del lobby**\n3. Se creará un canal privado automáticamente\n4. ¡Comparte para que entren los jugadores!\n\n*Necesitas tener el rol 🎮 Jugador o superior.*',
    faq_votacao_titulo: '🗳️ ¿Cómo funciona la votación?',
    faq_votacao_desc: '1. Cualquier miembro hace clic en **"🏁 Partida Terminó"**\n2. Se inicia una votación (dura **3 minutos**)\n3. Se necesitan **60% de votos Sí** para cerrar\n4. Si expira sin quórum, alguien puede iniciar otra\n5. El líder puede cancelar la votación o forzar el cierre',
    faq_lider_titulo: '👑 ¿Qué pasa si el líder sale?',
    faq_lider_desc: 'El liderazgo se **transfiere automáticamente** al miembro más antiguo de la sala.\n\nEl líder también puede transferir manualmente haciendo clic en **"👑 Transferir Líder"** en el canal privado.\n\nLa sala solo se cierra si el **último miembro** sale.',
    faq_limite_titulo: '⚠️ ¿Cuáles son los límites?',
    faq_limite_desc: '• **1 sala por miembro** — sal de la actual para entrar a otra\n• **1 sala creada a la vez** — cierra la anterior para crear una nueva\n• **Cooldown de 3 min** después de cerrar una sala para crear otra\n• **Las salas expiran** después de 6 horas automáticamente',
    faq_codigo_titulo: '🔑 ¿Cómo cambiar el código del lobby?',
    faq_codigo_desc: 'El líder puede hacer clic en **"✏️ Cambiar Código"** en el canal privado en cualquier momento.\n\nUn pop-up pedirá el nuevo código. Todos los miembros serán avisados del cambio.',
    faq_notificacoes_titulo: '🔔 ¿Cómo funcionan las notificaciones?',
    faq_notificacoes_desc: 'En el canal de salas, haz clic en el botón **"🔔 Notificaciones"** para activar o desactivar.\n\n• **Activado** — Recibes una mención cada vez que se crea una nueva sala\n• **Desactivado** — Ya no serás notificado\n\nEl bot añade/quita el rol automáticamente. Haz clic de nuevo para alternar.',
    faq_historico_titulo: '📊 ¿Cómo ver mi historial?',
    faq_historico_desc: 'Escribe **`/meuhistorico`** en cualquier canal del servidor.\n\nEl bot muestra:\n• Tus **últimas 10 partidas**\n• Nombre de la sala, duración y cantidad de jugadores\n• Si fuiste líder (👑)\n• **Total de partidas** y **veces como líder**\n\nLa respuesta es visible solo para ti.',

    // Histórico
    historico_footer: 'Arkheron SA • Últimas 10 partidas',
    historico_footer_admin: 'Total registrado: {total} partida(s)',

    // Outros
    nenhum_membro: '*Ningún miembro*',
    e_mais: '*...y {count} jugador(es) más*',
    boa_partida: '¡Buena partida!',
    modo_debug: '\n\n⚠️ **MODO DEBUG ACTIVO**',
    footer_arkheron: 'Arkheron SA • Custom Game',
    footer_classes: 'Arkheron SA • Guía de Clases',
    footer_classes_menu: 'Arkheron SA • Guía de Clases • Usa el menú para ver otra clase',
    bonus_classe: '🏆 **Bono de Clase:** {bonus}',
    equipamentos_desc: '👑 **Corona** (Slot 1) • 💮 **Amuleto** (Slot 2) • ⚔️ **Arma 1** (Slot 3) • 🗡️ **Arma 2** (Slot 4)',
    slot_coroa: '👑 Corona (Slot 1)',
    slot_amuleto: '💮 Amuleto (Slot 2)',
    slot_arma1: '⚔️ Arma 1 (Slot 3)',
    slot_arma2: '🗡️ Arma 2 (Slot 4)',
    votos: 'votos',

    // Idioma
    idioma_mudou_es: '🌐 Idioma cambiado a **Español**. Todas las interacciones del bot ahora serán en español.',
    idioma_mudou_pt: '🌐 Idioma alterado para **Português**. Todas as interações do bot agora serão em português.',
    btn_mudar_idioma: '🌐 Português',
  },
};

// Função helper para tradução
function t(userId, key, vars = {}) {
  const lang = userLang.get(userId) || 'pt-BR';
  let text = TRADUCOES[lang]?.[key] || TRADUCOES['pt-BR']?.[key] || key;
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return text;
}

// Carregar preferências de idioma
function carregarIdiomas() {
  try {
    if (fs.existsSync(IDIOMAS_FILE)) {
      const data = JSON.parse(fs.readFileSync(IDIOMAS_FILE, 'utf-8'));
      for (const [userId, lang] of Object.entries(data)) {
        userLang.set(userId, lang);
      }
      logger.info(`Idiomas carregados: ${userLang.size} preferência(s)`);
    }
  } catch (e) {
    logger.warn(`Erro ao carregar idiomas: ${e.message}`);
  }
}

// Salvar preferências de idioma
function salvarIdiomas() {
  try {
    const data = Object.fromEntries(userLang);
    fs.writeFileSync(IDIOMAS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error(`Erro ao salvar idiomas: ${e.message}`);
  }
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

function buildConfirmacao(action, salaId, membrosCount, userId = null) {
  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(t(userId, 'embed_confirmacao_titulo'))
    .setDescription(
      action === 'encerrar'
        ? t(userId, 'confirm_encerrar_desc', { membros: membrosCount, segundos: CLOSE_DELAY_SEC })
        : t(userId, 'confirm_fechar_desc', { membros: membrosCount })
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirmar_${action}_${salaId}`).setLabel(t(userId, 'btn_confirmar')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cancelar_acao_${salaId}`).setLabel(t(userId, 'btn_cancelar')).setStyle(ButtonStyle.Secondary),
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

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mudar_idioma').setLabel('🌐 Español / Português').setStyle(ButtonStyle.Secondary),
  );

  await comoFunciona.send({ embeds: [embed], components: [row1, row2, row3] });
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
//  CLASSES — Dados e Setup
// ─────────────────────────────────────────────
const CLASSES = [
  {
    id: 'dahla', nome: 'Dahla', emoji: '\u2728', cor: 0xE91E8C,
    desc: 'Assassina \u00e1gil focada em invisibilidade e ataques r\u00e1pidos com l\u00e2minas.',
    bonus: 'Bolsos profundos: pilha m\u00e1xima de aumento dos consum\u00edveis',
    coroa: {
      nome: 'Vanish Crown', habilidade: 'VANISH',
      tags: 'Faseado \u2022 Aumento de Movement \u2022 Invis\u00edvel \u2022 Invulner\u00e1vel',
      stats: 'Recarga: 12s \u2022 Dura\u00e7\u00e3o: 1.5s',
      desc: 'Transforma-se num movimento r\u00e1pido invulner\u00e1vel/invis\u00edvel, saindo atr\u00e1s dos inimigos.',
      upgrades: 'II Recarga reduzida para 12s\nIII Ao deixar Vanish, invulner\u00e1vel a danos durante 1s',
    },
    amuleto: {
      nome: 'Petal Dance Amulet', habilidade: 'DAN\u00C7A DAS P\u00C9TALAS',
      tags: 'Curar \u2022 Idade \u2022 Capacidade canalizada',
      stats: 'Cura: 7.5 por 0.5s \u2022 Recarga: 14s \u2022 Dura\u00e7\u00e3o: 5s',
      desc: 'Cria v\u00f3rtice de p\u00e9talas que cura aliados ao longo do tempo.',
      upgrades: 'II Recarga reduzida para 14s\nIII Quantidade de cura aumentada para 79',
    },
    arma1: {
      nome: 'Dancing Blade', habilidade: 'VARIA\u00C7\u00C3O DE CORTE',
      tags: 'Piercing \u2022 Stun \u2022 Repor ao matar',
      stats: 'Dano CaC: 15/15/16/16 \u2022 Recarga: 12s',
      desc: 'Espinho torcido que atinge o alvo com ataques de perfura\u00e7\u00e3o e atordoamento.',
      upgrades: 'II Recarga reduzida para 12s\nIII Elimina\u00e7\u00f5es repor a recarga',
    },
    arma2: {
      nome: 'Facas de Arremesso', habilidade: 'LAN\u00C7AMENTO DE PROJETA',
      tags: 'Disparo cont\u00ednuo',
      stats: 'Dano a Dist\u00e2ncia: 9/9 \u2022 Muni\u00e7\u00f5es: 12',
      desc: 'Barreira da l\u00e2mina \u2014 cerque-os com facas. Each blade danos no impacto.',
      upgrades: 'II Recarga reduzida para 12s\nIII Projeta arremesso 2 facas cada rota\u00e7\u00e3o',
    },
  },
  {
    id: 'edani', nome: 'Edani', emoji: '\uD83D\uDD25', cor: 0xFF4444,
    desc: 'Ber\u00e7erker corpo a corpo com dano explosivo e lifesteal agressivo.',
    bonus: 'Feroz: dano corpo a corpo aumento de 20%',
    coroa: {
      nome: 'Coroa de Explos\u00e3o', habilidade: 'CREATIVE OUTBURST',
      tags: 'Destrui\u00e7\u00e3o \u2022 Idade',
      stats: 'Danos: 15-30 \u2022 Recarga: 12s \u2022 Dura\u00e7\u00e3o escape: 1.5s',
      desc: 'Ashnik que afasta os inimigos. Dano com base no n\u00famero de inimigos pr\u00f3ximos.',
      upgrades: 'II Recarga reduzida para 12s\nIII Raio de explos\u00e3o aumentado',
    },
    amuleto: {
      nome: 'Amuleto do Sofrimento', habilidade: 'MAIS, MELHOR',
      tags: 'Aura \u2022 Aumento de dano',
      stats: 'Recarga: 12s \u2022 Dura\u00e7\u00e3o: 6s \u2022 Gama Aura: 5m',
      desc: 'Aumenta o dano com base no n\u00famero de inimigos pr\u00f3ximos. Aumento de dano: 20%.',
      upgrades: 'II Recarga reduzida para 12s\nIII Amplifica\u00e7\u00e3o de dano para 20% por inimigo pr\u00f3ximo',
    },
    arma1: {
      nome: 'Gancho de Lunging', habilidade: 'THRASH DE PELE FINA',
      tags: 'Stun \u2022 Invulner\u00e1vel',
      stats: 'Dano CaC: 12/12/14.4/14.4/1 \u2022 Recarga: 12s',
      desc: 'Palav\u00f5es surpreendentes \u2014 jogue um gancho em um inimigo, puxando voc\u00ea para ele.',
      upgrades: 'II Recarga reduzida para 12s\nIII Carga bem-sucedida: invulner\u00e1vel a danos durante 1s',
    },
    arma2: {
      nome: 'Puxando Garras', habilidade: 'SCRATCH AND SHRED',
      tags: 'Stun \u2022 Jane access',
      stats: 'Dano CaC: 9.6/6/6/19.2/19.2/21.6/1 \u2022 Recarga: 12s',
      desc: 'Atra\u00e7\u00e3o irresist\u00edvel \u2014 lan\u00e7ar ambas as garras em dire\u00e7\u00e3o a um alvo e puxar para voc\u00ea.',
      upgrades: 'II Recarga reduzida para 12s\nIII Elimina\u00e7\u00f5es repor a recarga',
    },
  },
  {
    id: 'grimwold', nome: 'Grimwold', emoji: '\uD83D\uDEE1\uFE0F', cor: 0x4488FF,
    desc: 'Tanque com regenera\u00e7\u00e3o, portais e ataques de torre est\u00e1tica.',
    bonus: 'Galvanizado: Fortaleza e Sa\u00fade \u2014 Regenerar se n\u00e3o tiver danos sofridos nos \u00faltimos 3s',
    coroa: {
      nome: 'Coroa Oscilante', habilidade: 'REGENERA\u00C7\u00C3O OSCILANTE',
      tags: 'Teleporta\u00e7\u00e3o \u2022 Curar',
      stats: 'Recarga: 15s \u2022 Cura: 65 \u2022 Dura\u00e7\u00e3o: 10s',
      desc: 'Cria um portal. Lan\u00e7ando a\u00e7\u00e3o retorna para o portal e cura voc\u00ea.',
      upgrades: 'II Recarga reduzida para 15s\nIII Cura aumentada para 65',
    },
    amuleto: {
      nome: 'Amuleto Voltaico', habilidade: 'BARREIRA VOLTAICA',
      tags: 'Contra \u2022 Bloco',
      stats: 'Recarga: 10s \u2022 Dura\u00e7\u00e3o: 8s',
      desc: 'Uma barreira que bloqueia proj\u00e9teis inimigos e companheiros de equipa atrav\u00e9s dela.',
      upgrades: 'II Recarga reduzida para 10s\nIII Dura\u00e7\u00e3o aumentada para 8s',
    },
    arma1: {
      nome: 'Dispositivo Estranho', habilidade: 'CHOQUE / TORRE EST\u00C1TICA',
      tags: 'Ataque canalizado \u2022 Alvo suave \u2022 Summon \u2022 Explos\u00e3o',
      stats: 'Dano a Dist\u00e2ncia: 4-11 por 0.3s \u2022 Torre: Danos 10 / Sa\u00fade 100hp \u2022 Recarga: 12s',
      desc: 'Segure para danificar um \u00fanico alvo pr\u00f3ximo. Torre est\u00e1tica que visa o mais pr\u00f3ximo.',
      upgrades: 'II Recarga reduzida para 12s\nIII Detona\u00e7\u00e3o de Torre est\u00e1tica (50 de dano) quando destru\u00edda',
    },
    arma2: {
      nome: 'An\u00e9is Carregados', habilidade: 'TIRO \u00daNICO / REA\u00C7\u00C3O EM CADEIA',
      tags: 'Desloca\u00e7\u00e3o \u2022 Bounce',
      stats: 'Dano a Dist\u00e2ncia: 25-38 \u2022 Cadeia: Dano 15 \u2022 Recarga: 10s',
      desc: 'Um proj\u00e9til que clarifica e empurra inimigos de volta. Rea\u00e7\u00e3o em Cadeia salta entre alvos.',
      upgrades: 'II Recarga reduzida para 10s\nIII Rea\u00e7\u00e3o em Cadeia vai saltar at\u00e9 8 alvos',
    },
  },
  {
    id: 'irenna', nome: 'Irenna', emoji: '\u2744\uFE0F', cor: 0x88CCFF,
    desc: 'Guerreira de gelo com armadura pesada, aura de lentid\u00e3o e ataques de cone gelado.',
    bonus: 'Sangue frio: aumento de 25% danos causados por atordoados ou retardados',
    coroa: {
      nome: 'Frost Armor Crown', habilidade: 'FROST ARMOR',
      tags: 'Armor \u2022 Capacidade canalizada \u2022 Nega Piercing \u2022 Nega Estagnamento',
      stats: 'Recarga: 20s \u2022 Durabilidade: 100 CV \u2022 Dura\u00e7\u00e3o: 12s',
      desc: 'Camada de sa\u00fade adicional que nega danos por perfura\u00e7\u00e3o e estagnamento.',
      upgrades: 'II Recarga reduzida para 20s\nIII Canais Frost Armor 25% mais r\u00e1pidos',
    },
    amuleto: {
      nome: 'Amuleto do Vento Norte', habilidade: 'NORTHERN WIND',
      tags: 'Aura',
      stats: 'Recarga: 14s \u2022 Gama Aura: 4m \u2022 Dura\u00e7\u00e3o: 4s',
      desc: 'Uma aura que retarda o movimento dos inimigos. Diminui\u00e7\u00e3o de velocidade: 30%.',
      upgrades: 'II Recarga reduzida para 14s\nIII Aumento do tamanho da Aura',
    },
    arma1: {
      nome: 'Ma\u00e7a Quebra-Gelo', habilidade: 'FURTOS INSENS\u00cdVEIS / QUEBRA-GELO',
      tags: 'Lento \u2022 Ataque cone \u2022 Raiz',
      stats: 'Dano CaC: 26/28 \u2022 Recarga: 12s \u2022 Dura\u00e7\u00e3o lenta: 1.5s',
      desc: 'Um cone de gelo que retarda e danifica inimigos. Enemies no centro ficam enraizados por 2s.',
      upgrades: 'II Recarga reduzida para 12s\nIII Enemies no centro do cone est\u00e3o enraizados por 2s',
    },
    arma2: {
      nome: 'Espada Zelador', habilidade: 'PESTANAS PRAGM\u00C1TICAS / APERTO KURIANO',
      tags: 'Stun \u2022 Piercing',
      stats: 'Dano CaC: 20/20/26 \u2022 Recarga: 12s',
      desc: 'Empurre para a frente e perfure um alvo com stun e piercing.',
      upgrades: 'II Recarga reduzida para 12s\nIII Atordoamento aumentado para 7s',
    },
  },
  {
    id: 'karriv', nome: 'Karriv', emoji: '\uD83D\uDD25', cor: 0xFF8800,
    desc: 'Mago de fogo com totem protetor, proj\u00e9teis flamejantes e ondas de chama.',
    bonus: 'Persistente: Cooldowns de habilidade s\u00e3o 20% mais r\u00e1pidos',
    coroa: {
      nome: 'Forgefire Crown', habilidade: 'FORJAR FOGO',
      tags: 'Idade \u2022 Mitiga\u00e7\u00e3o de danos \u2022 Summon',
      stats: 'Recarga: 12.8s \u2022 Dura\u00e7\u00e3o: 7s \u2022 Sa\u00fade: 100hp',
      desc: 'Coloque um totem protetor que cura e mitiga danos aos seus criadores de equipa.',
      upgrades: 'II Recarga reduzida para 16s\nIII Dura\u00e7\u00e3o aumentada para 7s',
    },
    amuleto: {
      nome: 'Amuleto Flamepath', habilidade: 'FLAMEPATH',
      tags: 'Danos ao longo do tempo \u2022 AoE',
      stats: 'Danos: 12 + 6 Pontos \u2022 Recarga: 10.4s \u2022 Dist\u00e2ncia: 7m',
      desc: 'Inscreva um caminho de chamas ardente no ch\u00e3o.',
      upgrades: 'II Recarga reduzida para 13s\nIII Dura\u00e7\u00e3o aumentada para 10s',
    },
    arma1: {
      nome: 'Lanterna Flamejante', habilidade: 'GOLPEIE A BIGORNA / EMBER TOSS',
      tags: 'Danos ao longo do tempo \u2022 Ataque a\u00e9reo \u2022 AoE',
      stats: 'Dano CaC: 18/18/18/18+5 AoE +8 \u2022 Dano Dist: 25 + 6 \u2022 Recarga: 8s',
      desc: 'Proj\u00e9til lan\u00e7ado que explode em carvonhas ardentes. Ember Toss permanece no ch\u00e3o 3s.',
      upgrades: 'II Recarga reduzida para 10s\nIII Ember Toss permanece no ch\u00e3o durante 3s',
    },
    arma2: {
      nome: 'P\u00e1 Abrasadora', habilidade: 'BALAN\u00C7O DA P\u00C1 / EXPLOS\u00C3O ABRASADORA',
      tags: 'Danos ao longo do tempo \u2022 Passar \u2022 Explos\u00e3o',
      stats: 'Dano CaC: 24/24/28+15 AoE +8 \u2022 Dano Dist: 25/10 \u2022 Recarga: 9.6s',
      desc: 'Uma onda de flame que passa por alvos e os incendeia.',
      upgrades: 'II Recarga reduzida para 12s\nIII Explos\u00e3o abrasadora quando a onda passa por um alvo',
    },
  },
  {
    id: 'leodin', nome: 'Leodin', emoji: '\u2694\uFE0F', cor: 0xFFD700,
    desc: 'Cavaleiro divino com escudo radiante, lifesteal e reflex\u00e3o de danos.',
    bonus: 'Divine: 20% De Redu\u00e7\u00e3o De Dano',
    coroa: {
      nome: 'Coroa Radiante', habilidade: 'RADIANT SHIELD',
      tags: 'Invulner\u00e1vel \u2022 Lifesteal \u2022 AoE \u2022 Brilhagem',
      stats: 'Danos: 15-30 \u2022 Lifesteal: Self 15.0-30.0 \u2022 Recarga: 15s',
      desc: 'Insere um estado invulner\u00e1vel. Sair cria um lifesteal/explos\u00e3o. Janela da ativa\u00e7\u00e3o: 3s.',
      upgrades: 'II Recarga reduzida para 15s\nIII Dano causado no sa\u00edda do Escudo agora cura para 100%',
    },
    amuleto: {
      nome: 'Amuleto do Santu\u00e1rio', habilidade: 'SANTU\u00C1RIO',
      tags: 'AoE \u2022 Steadfast',
      stats: 'Recarga: 12s \u2022 \u00c1rea de escala de efeito: 8m \u2022 Dura\u00e7\u00e3o: 6s',
      desc: '\u00c1rea Santu\u00e1rio. While dentro dele, voc\u00ea e companheiros de equipa est\u00e3o firmes.',
      upgrades: 'II Recarga reduzida para 12s\nIII Raio Aumentado',
    },
    arma1: {
      nome: 'Eclipse Hammer', habilidade: 'ALEGRE BALAN\u00C7O / BALAN\u00C7O JUSTO',
      tags: 'Stun \u2022 Knockback \u2022 Brilhagem',
      stats: 'Dano CaC: 20/20/30/30 \u2022 Balan\u00e7o Justo: Dano 38 \u2022 Recarga: 10s',
      desc: 'Martelo de duas m\u00e3os que derruba os inimigos para tr\u00e1s.',
      upgrades: 'II Recarga reduzida para 10s\nIII \u00daltima greve devastadora com \u00e1rea de efeito aumentada',
    },
    arma2: {
      nome: 'Lan\u00e7a Glint', habilidade: 'IMPULSO DIVINO / REFLECT',
      tags: 'Ataque canalizado \u2022 Bloco \u2022 Danos refletidos',
      stats: 'Dano CaC: 23-45 \u2022 Reflect Danos: 100% \u2022 Recarga: 12s',
      desc: 'Uma faca lan\u00e7ada que perfura inimigos. Reflect projeta e bloqueia dano corpo a corpo.',
      upgrades: 'II Recarga reduzida para 12s\nIII Alcance do Impulso Divino aumentado quando carregado',
    },
  },
  {
    id: 'penepole', nome: 'Penepole', emoji: '\uD83D\uDD2E', cor: 0x66BBFF,
    desc: 'Maga de longo alcance com proj\u00e9teis arcanos, cegueira e escudo invulner\u00e1vel.',
    bonus: 'Jovem: ganhar dois extra endurance pips',
    coroa: {
      nome: 'Sparkle Crown', habilidade: 'SPARKLE',
      tags: 'Idade \u2022 Cegos \u2022 Ataque a\u00e9reo',
      stats: 'Danos: 15 \u2022 Recarga: 12s \u2022 Dura\u00e7\u00e3o cegos: 7s',
      desc: 'Um proj\u00e9til que explode e forma uma nebulosidade. Enemies dentro da bolha ficam cegos.',
      upgrades: 'II Recarga reduzida para 12s\nIII Dura\u00e7\u00e3o dos cegos aumentada para 7s',
    },
    amuleto: {
      nome: 'Amuleto de Corre\u00e7\u00e3o', habilidade: 'TRANQUE A PORTA',
      tags: 'AoE \u2022 Tether',
      stats: 'Dano a Dist\u00e2ncia: 15 \u2022 Recarga: 12s \u2022 Dura\u00e7\u00e3o: 4s',
      desc: 'Uma onda oscilante que prende os inimigos perto. A corda pode ser quebrada por esfor\u00e7o.',
      upgrades: 'II Recarga reduzida para 12s\nIII Aumento da durabilidade da corda',
    },
    arma1: {
      nome: 'Espelho', habilidade: 'FRAGMENTOS VOADORES / ILUMINE O C\u00c9U',
      tags: 'Disparo cont\u00ednuo \u2022 Redu\u00e7\u00e3o da recarga',
      stats: 'Dano a Dist\u00e2ncia: 5 \u2022 Ilumine: Dano 15 \u2022 Recarga: 10s',
      desc: 'Ataque a dist\u00e2ncia cont\u00ednuo. Acertar inimigos reduz capacidade de recarga. Detonar fragmentos.',
      upgrades: 'II Recarga reduzida para 10s\nIII Cacos Adicionais',
    },
    arma2: {
      nome: 'Guarda-Sol de Porcelana', habilidade: 'EXPLOS\u00c3O ACERTADA / SOB O CLIMA',
      tags: 'Passar \u2022 Invulner\u00e1vel',
      stats: 'Dano a Dist\u00e2ncia: 5 \u2022 Muni\u00e7\u00f5es: 3 \u2022 Alcance: 3.5m \u2022 Recarga: 12s',
      desc: 'Sob o clima \u2014 uma esqu\u00edva descendal com um invulner\u00e1vel instant\u00e2neo. Rodopia o guarda-sol.',
      upgrades: 'II Recarga reduzida para 12s\nIII Contagem de muni\u00e7\u00e3o aumentada para 3',
    },
  },
  {
    id: 'ravah', nome: 'Ravah', emoji: '\uD83C\uDF19', cor: 0x8844AA,
    desc: 'Ca\u00e7adora furtiva com invisibilidade, besta de longo alcance e l\u00e2mina voadora.',
    bonus: 'Distante: dano a dist\u00e2ncia aumentado em 20%',
    coroa: {
      nome: 'Shadowsmoke Coroa', habilidade: 'SHADOWSMOKE',
      tags: 'Invis\u00edvel \u2022 Idade',
      stats: 'Danos: 2.5 por 0.5s \u2022 Recarga: 16s \u2022 \u00c1rea de efeito: 8m',
      desc: 'Nuvem de fuma\u00e7a que torna voc\u00ea e companheiros invis\u00edveis. Atacar revela-te.',
      upgrades: 'II Recarga reduzida para 16s\nIII Inimigos recebem 2.5 de dano por segundo em p\u00e9',
    },
    amuleto: {
      nome: 'Amuleto de Persegui\u00e7\u00e3o', habilidade: 'PERSEGUI\u00C7\u00C3O',
      tags: 'Aumento de danos \u2022 Stealth\u00e9d',
      stats: 'Recarga: 12s \u2022 Dura\u00e7\u00e3o: 2s \u2022 Aumento de Dano: 30%',
      desc: 'Tornar-se furtivo e o movimento ganha velocidade. Repor no kill. Aumento de Velocidade: 75%.',
      upgrades: 'II Recarga reduzida para 12s\nIII Repor atrav\u00e9s de abates',
    },
    arma1: {
      nome: 'Talonflight Besta', habilidade: 'PIERCING TIRO / UNLOAD',
      tags: 'Ataque carregado \u2022 Piercing \u2022 Knockback \u2022 Stun',
      stats: 'Dano a Dist\u00e2ncia: 24-48 \u2022 Unload: Dano 30 \u2022 Recarga: 10s',
      desc: 'T\u00eernio que atravessa a armadura. Unload: explos\u00e3o de danos que empurra voc\u00ea e os inimigos.',
      upgrades: 'II Recarga reduzida para 10s\nIII Carga da besta agora passa por alvos',
    },
    arma2: {
      nome: 'L\u00e2mina de Anel', habilidade: 'LAN\u00C7AMENTO / TORNAR VOO',
      tags: 'Tiro \u00fanico \u2022 Elmsed \u2022 Teleporte \u2022 Repor ao matar',
      stats: 'Dano a Dist\u00e2ncia: 21.6/1 \u2022 Tornar Voo: Dano 36 \u2022 Recarga: 10s',
      desc: 'Uma arma de longo alcance que pode incorporar nos inimigos. Teleporte para a l\u00e2mina.',
      upgrades: 'II Recarga reduzida para 10s\nIII Elimina\u00e7\u00f5es repor a recarga',
    },
  },
  {
    id: 'rynshi', nome: 'Rynshi', emoji: '\u26A1', cor: 0xAA44FF,
    desc: 'Guerreiro furioso com grito cegante, v\u00f3rtex de stun e socos velozes.',
    bonus: 'Implaciv\u00e9l: 40% De Dano + Ced\u00eancia: Redu\u00e7\u00e3o com baixa sa\u00fade (75HP)',
    coroa: {
      nome: 'Coroa da Raiva Cegante', habilidade: 'RUGIDO OFUSCANTE',
      tags: 'Cegos \u2022 Dados',
      stats: 'Danos: 20 \u2022 Recarga: 12s \u2022 Dura\u00e7\u00e3o cego: 6s',
      desc: 'Um grito de guerra que cega os inimigos pr\u00f3ximos.',
      upgrades: 'II Recarga reduzida para 12s\nIII Dura\u00e7\u00e3o de cegos aumentada para 6s',
    },
    amuleto: {
      nome: 'Vortex Amulet', habilidade: 'VORTEX',
      tags: 'AoE \u2022 Stun \u2022 Ataque a\u00e9reo',
      stats: 'Danos: 15 \u2022 Recarga: 12s \u2022 \u00c1rea de efeito: 3.5m',
      desc: 'Um v\u00f3rtice que puxa inimigos ao seu centro, atordoando-os no impacto.',
      upgrades: 'II Recarga reduzida para 12s\nIII Dura\u00e7\u00e3o do atordoamento aumentada para 1s',
    },
    arma1: {
      nome: 'Wrath Cleaver', habilidade: 'CLEAVE / SAVAGE LEAP',
      tags: 'Ataque a\u00e9reo \u2022 Brilhagem \u2022 Stun \u2022 AoE',
      stats: 'Dano CaC: 20/28/25/30 \u2022 Savage Leap: Dano 45 \u2022 Recarga: 10s',
      desc: 'Salte para cima e esmaga. Stun na aterragem. \u00c1rea de efeito: 1.5m.',
      upgrades: 'II Recarga reduzida para 10s\nIII Hit now atordoa jogadores por 1s',
    },
    arma2: {
      nome: 'Bracadeiras de F\u00faria', habilidade: 'FURY SOCOS / ARREMESSO S\u00c1DICO',
      tags: 'Piercing \u2022 Agarrar \u2022 Lega\u00e7\u00e3o \u2022 Vulner\u00e1vel',
      stats: 'Dano CaC: 18/20/20/25/28 \u2022 Arremesso: Dano 10/35 \u2022 Recarga: 12s',
      desc: 'Pegue um inimigo pr\u00f3ximo e jogue-o para longe. Janela de ativa\u00e7\u00e3o: 3s.',
      upgrades: 'II Recarga reduzida para 12s\nIII Lan\u00e7ar um inimigo indicar\u00e1 25% mais danos por 5s',
    },
  },
  {
    id: 'tsubo', nome: 'Tsubo', emoji: '\uD83D\uDCAA', cor: 0xCC2222,
    desc: 'Bruto impar\u00e1vel com summon, lifesteal alto, estagnamento e controle de \u00e1rea.',
    bonus: 'Ending: causar 70% a mais de dano em baixa sa\u00fade (75HP)',
    coroa: {
      nome: 'Coroa do Antepassado', habilidade: 'YAHTOWA',
      tags: 'Summon \u2022 Danos ao longo do tempo',
      stats: 'Danos: 5 + 10 Pontos \u2022 Recarga: 15s \u2022 Dura\u00e7\u00e3o: 8s \u2022 Sa\u00fade: 100hp',
      desc: 'Convoque um espirito para lutar ao seu lado. Ele perseguir\u00e1 alvos com ping.',
      upgrades: 'II Recarga reduzida para 15s\nIII Sa\u00fade do c\u00e3o aumentada para 100',
    },
    amuleto: {
      nome: 'Executar Amuleto Livre', habilidade: 'CORRER LIVRE',
      tags: 'Faseado \u2022 Lifesteal \u2022 Passar \u2022 Steadfast',
      stats: 'Danos: 20 \u2022 Recarga: 12s \u2022 Dura\u00e7\u00e3o: 0.45s \u2022 Lifesteal: 100%',
      desc: 'Avan\u00e7ar, danificando os inimigos que voc\u00ea passar.',
      upgrades: 'II Recarga reduzida para 12s\nIII Executar ganhos livres Lifesteal',
    },
    arma1: {
      nome: 'L\u00e2minas do Estripador', habilidade: 'SLASH AND SMASH / TORNA-LOS PRESAS',
      tags: 'Ataque cone \u2022 Weaken \u2022 Estagnamento',
      stats: 'Dano CaC: 10/10/10/1/10/30 \u2022 Recarga: 10s',
      desc: 'Ataque em forma de leque que faz inimigos ficarem lentos. Porcentagem de estagnamento: 30%.',
      upgrades: 'II Recarga reduzida para 16s\nIII Dura\u00e7\u00e3o aumentada para 3s',
    },
    arma2: {
      nome: 'Boom-Chakas', habilidade: 'BOOM-CRACK / BIND',
      tags: 'Ataque carregado \u2022 Explos\u00e3o \u2022 Bind \u2022 Stun',
      stats: 'Dano a Dist\u00e2ncia: 13/9/9/9 \u2022 Bind: Dano 20 \u2022 Recarga: 12s \u2022 Dura\u00e7\u00e3o: 3s',
      desc: 'Ataque que pode ser carregado para explodir ao acertar. Bind limita a capacidade de correr.',
      upgrades: 'II Cooldown reduzido para 12s\nIII Dura\u00e7\u00e3o aumentada para 3s',
    },
  },
];

async function enviarPainelClasses(guild) {
  if (!CLASSES_CATEGORY_ID) return;

  // Procura canal existente na categoria
  let classesCh = guild.channels.cache.find(
    c => c.parentId === CLASSES_CATEGORY_ID && c.name.includes('classes')
  );

  // Cria se nao existe
  if (!classesCh) {
    classesCh = await guild.channels.create({
      name: '\uD83D\uDCD6\u30FBclasses',
      type: ChannelType.GuildText,
      parent: CLASSES_CATEGORY_ID,
      topic: 'Selecione uma classe para ver seus equipamentos e habilidades',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ],
    });
    logger.info(`Canal de classes criado: ${classesCh.id}`);
  }

  // Limpa msgs antigas do bot
  const msgs = await classesCh.messages.fetch({ limit: 20 });
  for (const [, m] of msgs) {
    if (m.author.id === client.user.id) await m.delete().catch(() => {});
  }

  const listaClasses = CLASSES.map(c => `${c.emoji} **${c.nome}** \u2014 ${c.desc}`).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x7B2FBE)
    .setTitle('\uD83D\uDCD6 Classes \u2014 Arkheron')
    .setDescription(
      'Conhe\u00e7a todas as classes dispon\u00edveis no jogo!\n' +
      'Selecione uma classe no menu abaixo para ver os **equipamentos e habilidades**.\n\n' +
      listaClasses
    )
    .addFields(
      { name: '\uD83C\uDFAE Equipamentos', value: '\uD83D\uDC51 **Coroa** (Slot 1) \u2022 \uD83D\uDCAE **Amuleto** (Slot 2) \u2022 \u2694\uFE0F **Arma 1** (Slot 3) \u2022 \uD83D\uDDE1\uFE0F **Arma 2** (Slot 4)', inline: false },
    )
    .setFooter({ text: 'Arkheron SA \u2022 Guia de Classes' });

  const options = CLASSES.map(c => ({
    label: c.nome,
    description: c.desc.substring(0, 100),
    value: c.id,
    emoji: c.emoji,
  }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_classe')
      .setPlaceholder('\uD83D\uDD0D Selecione uma classe...')
      .addOptions(options)
  );

  await classesCh.send({ embeds: [embed], components: [row] });
  logger.info('Painel de classes enviado');
}

// ─────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────
client.once('clientReady', async () => {
  logger.info(`Bot online: ${client.user.tag}`);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { logger.error('Servidor nao encontrado!'); return process.exit(1); }
  const salasCh = guild.channels.cache.get(SALAS_CHANNEL_ID);
  if (!salasCh) { logger.error('Canal de salas nao encontrado!'); return process.exit(1); }

  // Carregar preferências de idioma
  carregarIdiomas();

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

  // Painel de classes
  await enviarPainelClasses(guild);

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
      const userId = interaction.user.id;
      const historico = carregarHistoricoUsuario(userId, 10);

      if (historico.length === 0) {
        return interaction.reply({ content: t(userId, 'resp_sem_historico'), flags: MessageFlags.Ephemeral });
      }

      const totalPartidas = carregarHistoricoUsuario(userId, 200).length;
      const vezesCriador = carregarHistoricoUsuario(userId, 200).filter(h => h.criadorId === userId).length;

      const lista = historico.reverse().map((h, i) => {
        const duracao = h.fechadoEm && h.criadoEm ? Math.round((h.fechadoEm - h.criadoEm) / 60) : '?';
        const foiLider = h.criadorId === userId ? ' 👑' : '';
        return `**${i + 1}.** 🎮 **${h.nome}**${foiLider}\n   └ ${h.membros} jogadores • ${duracao} min • <t:${h.fechadoEm}:d>`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x7B2FBE)
        .setTitle(t(userId, 'embed_historico_titulo', { nome: interaction.user.displayName }))
        .setDescription(lista.substring(0, 4000))
        .addFields(
          { name: t(userId, 'field_total_partidas'), value: `${totalPartidas}`, inline: true },
          { name: t(userId, 'field_vezes_lider'), value: `${vezesCriador}`, inline: true },
        )
        .setThumbnail(interaction.user.displayAvatarURL())
        .setFooter({ text: t(userId, 'historico_footer') });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  FAQ
    // ══════════════════════════════════════════
    if (interaction.isButton() && FAQ_RESPOSTAS[interaction.customId]) {
      const faq = FAQ_RESPOSTAS[interaction.customId];
      const userId = interaction.user.id;
      const embed = new EmbedBuilder()
        .setColor(0x7B2FBE)
        .setTitle(t(userId, `${interaction.customId}_titulo`))
        .setDescription(t(userId, `${interaction.customId}_desc`));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  MUDAR IDIOMA
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'mudar_idioma') {
      const userId = interaction.user.id;
      const currentLang = userLang.get(userId) || 'pt-BR';
      const newLang = currentLang === 'pt-BR' ? 'es' : 'pt-BR';

      userLang.set(userId, newLang);
      salvarIdiomas();

      const msg = newLang === 'es'
        ? t(userId, 'idioma_mudou_es')
        : t(userId, 'idioma_mudou_pt');

      return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  TOGGLE NOTIFICACOES
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'toggle_notify') {
      const userId = interaction.user.id;
      if (!NOTIFY_ROLE_ID) return interaction.reply({ content: t(userId, 'resp_notify_erro'), flags: MessageFlags.Ephemeral });

      const member = interaction.member;
      if (member.roles.cache.has(NOTIFY_ROLE_ID)) {
        await member.roles.remove(NOTIFY_ROLE_ID).catch(() => {});
        return interaction.reply({ content: t(userId, 'resp_notify_desativadas'), flags: MessageFlags.Ephemeral });
      } else {
        await member.roles.add(NOTIFY_ROLE_ID).catch(() => {});
        return interaction.reply({ content: t(userId, 'resp_notify_ativadas'), flags: MessageFlags.Ephemeral });
      }
    }

    // ══════════════════════════════════════════
    //  SELECT: CLASSE
    // ══════════════════════════════════════════
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_classe') {
      const userId = interaction.user.id;
      const classeId = interaction.values[0];
      const classe = CLASSES.find(c => c.id === classeId);
      if (!classe) return interaction.reply({ content: t(userId, 'resp_classe_nao_encontrada'), flags: MessageFlags.Ephemeral });

      const formatSlot = (slot, icone, label) => {
        return `${icone} **${slot.nome}**\n` +
          `> **${slot.habilidade}**\n` +
          `> ${slot.tags}\n` +
          `> \uD83D\uDCCA ${slot.stats}\n` +
          `> *${slot.desc}*\n` +
          `> \n` +
          `> **Upgrades:**\n` +
          `> ${slot.upgrades.replace(/\n/g, '\n> ')}`;
      };

      const embedPrincipal = new EmbedBuilder()
        .setColor(classe.cor)
        .setTitle(`${classe.emoji} ${classe.nome}`)
        .setDescription(
          `*${classe.desc}*\n\n` +
          `\uD83C\uDFC6 **B\u00f4nus de Classe:** ${classe.bonus}`
        )
        .setFooter({ text: 'Arkheron SA \u2022 Guia de Classes \u2022 Use o menu para ver outra classe' });

      const embedCoroa = new EmbedBuilder()
        .setColor(classe.cor)
        .setTitle('\uD83D\uDC51 Coroa (Slot 1)')
        .setDescription(formatSlot(classe.coroa));

      const embedAmuleto = new EmbedBuilder()
        .setColor(classe.cor)
        .setTitle('\uD83D\uDCAE Amuleto (Slot 2)')
        .setDescription(formatSlot(classe.amuleto));

      const embedArma1 = new EmbedBuilder()
        .setColor(classe.cor)
        .setTitle('\u2694\uFE0F Arma 1 (Slot 3)')
        .setDescription(formatSlot(classe.arma1));

      const embedArma2 = new EmbedBuilder()
        .setColor(classe.cor)
        .setTitle('\uD83D\uDDE1\uFE0F Arma 2 (Slot 4)')
        .setDescription(formatSlot(classe.arma2));

      return interaction.reply({
        embeds: [embedPrincipal, embedCoroa, embedAmuleto, embedArma1, embedArma2],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ══════════════════════════════════════════
    //  CRIAR SALA
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'criar_sala') {
      const userId = interaction.user.id;
      if (!temCargoMinimo(interaction.member)) {
        return interaction.reply({ content: t(userId, 'resp_sem_cargo'), flags: MessageFlags.Ephemeral });
      }
      if (salas.size >= MAX_SALAS) {
        return interaction.reply({ content: t(userId, 'resp_limite_salas', { max: MAX_SALAS }), flags: MessageFlags.Ephemeral });
      }
      if ([...salas.values()].some(s => s.criadorId === userId && !s.fechando)) {
        return interaction.reply({ content: t(userId, 'resp_ja_tem_sala'), flags: MessageFlags.Ephemeral });
      }
      // Cooldown
      const lastClose = cooldowns.get(userId);
      if (lastClose && Date.now() - lastClose < COOLDOWN_MS) {
        const restante = Math.ceil((COOLDOWN_MS - (Date.now() - lastClose)) / 1000);
        return interaction.reply({ content: t(userId, 'resp_cooldown', { segundos: restante }), flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder().setCustomId('modal_criar_sala').setTitle(t(userId, 'modal_criar_titulo'));
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sala_nome').setLabel(t(userId, 'modal_criar_nome')).setStyle(TextInputStyle.Short).setPlaceholder(t(userId, 'modal_criar_nome_placeholder')).setMaxLength(50).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sala_codigo').setLabel(t(userId, 'modal_criar_codigo')).setStyle(TextInputStyle.Short).setPlaceholder(t(userId, 'modal_criar_codigo_placeholder')).setMaxLength(20).setRequired(true)
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
      if (!categoria) return interaction.editReply({ content: t(criadorId, 'resp_categoria_erro') });

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
      await interaction.editReply({ content: t(criadorId, 'resp_sala_criada', { nome, canal: textChannel }) });
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
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== userId) return interaction.reply({ content: t(userId, 'resp_apenas_lider'), flags: MessageFlags.Ephemeral });

      const novoCodigo = interaction.fields.getTextInputValue('novo_codigo');
      sala.codigo = novoCodigo;
      salvarEstado();

      await atualizarEmbedPrivado(salaId, guild);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.send(t(sala.criadorId, 'msg_codigo_atualizado', { user: userId, codigo: novoCodigo })).catch(() => {});

      await interaction.reply({ content: t(userId, 'resp_codigo_alterado', { codigo: novoCodigo }), flags: MessageFlags.Ephemeral });
      logger.info(`Codigo alterado na sala ${salaId}: ${novoCodigo}`);
      return;
    }

    // ══════════════════════════════════════════
    //  ENTRAR NA SALA
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('entrar_')) {
      const salaId = interaction.customId.replace('entrar_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;

      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_fechando'), flags: MessageFlags.Ephemeral });
      if (sala.emAndamento) return interaction.reply({ content: t(userId, 'resp_partida_andamento'), flags: MessageFlags.Ephemeral });
      if (sala.membros.size >= sala.vagas) return interaction.reply({ content: t(userId, 'resp_sala_cheia'), flags: MessageFlags.Ephemeral });
      if (sala.membros.has(userId)) return interaction.reply({ content: t(userId, 'resp_ja_na_sala'), flags: MessageFlags.Ephemeral });

      // Limite: 1 sala por membro
      const jaEstaEmOutra = [...salas.values()].some(s => s.membros.has(userId) && s.id !== salaId && !s.fechando);
      if (jaEstaEmOutra) {
        return interaction.reply({ content: t(userId, 'resp_em_outra_sala'), flags: MessageFlags.Ephemeral });
      }

      sala.membros.add(userId);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.permissionOverwrites.create(userId, { ViewChannel: true, SendMessages: true });

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      if (textCh) await textCh.send(t(sala.criadorId, 'msg_membro_entrou', { user: userId, atual: sala.membros.size, total: sala.vagas }));

      // Notificacao: sala cheia
      if (sala.membros.size >= sala.vagas && textCh) {
        await textCh.send(t(sala.criadorId, 'msg_sala_cheia', { lider: sala.criadorId, total: sala.vagas })).catch(() => {});
      }

      // DM com codigo do lobby
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(0x7B2FBE)
          .setTitle(t(userId, 'dm_titulo', { nome: sala.nome }))
          .setDescription(t(userId, 'dm_desc'))
          .addFields(
            { name: t(userId, 'field_codigo'), value: `\`\`\`${sala.codigo}\`\`\``, inline: false },
            { name: t(userId, 'dm_canal'), value: `<#${sala.textChannelId}>`, inline: true },
          )
          .setFooter({ text: t(userId, 'footer_arkheron') });
        await interaction.user.send({ embeds: [dmEmbed] });
      } catch {
        // DMs desativadas — segue sem avisar
      }

      salvarEstado();
      await interaction.reply({ content: t(userId, 'resp_voce_entrou', { canal: textCh }), flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  SAIR DA SALA (publico)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('sair_') && !interaction.customId.startsWith('sair_privado_')) {
      const salaId = interaction.customId.replace('sair_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.emAndamento) return interaction.reply({ content: t(userId, 'resp_partida_andamento'), flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(userId)) return interaction.reply({ content: t(userId, 'resp_nao_na_sala'), flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: t(userId, 'resp_voce_saiu'), flags: MessageFlags.Ephemeral });
      await removerMembro(salaId, userId, guild);
      return;
    }

    // ══════════════════════════════════════════
    //  SAIR DA SALA (privado)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('sair_privado_')) {
      const salaId = interaction.customId.replace('sair_privado_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.emAndamento) return interaction.reply({ content: t(userId, 'resp_partida_andamento'), flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(userId)) return interaction.reply({ content: t(userId, 'resp_nao_na_sala'), flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: t(userId, 'resp_voce_saiu'), flags: MessageFlags.Ephemeral });
      await removerMembro(salaId, userId, guild);
      return;
    }

    // ══════════════════════════════════════════
    //  PARTIDA ACABOU (inicia votacao)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('partida_acabou_')) {
      const salaId = interaction.customId.replace('partida_acabou_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(userId)) return interaction.reply({ content: t(userId, 'resp_nao_na_sala'), flags: MessageFlags.Ephemeral });
      if (sala.votacao.ativa) return interaction.reply({ content: t(userId, 'resp_votacao_andamento'), flags: MessageFlags.Ephemeral });

      sala.votacao = { ativa: true, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: Date.now() };

      const textCh = guild.channels.cache.get(sala.textChannelId);
      const votMsg = await textCh.send({
        content: t(sala.criadorId, 'msg_votacao_iniciada', { minutos: Math.floor(VOTE_TIMEOUT_MS / 60000) }),
        embeds: [buildVotacaoEmbed(sala)],
        components: [buildVotacaoBotoes(salaId)],
      });
      sala.votacao.messageId = votMsg.id;
      iniciarVotacaoTimeout(salaId, guild);
      salvarEstado();
      await interaction.reply({ content: t(userId, 'resp_votacao_iniciada'), flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  VOTAR SIM
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('votar_sim_')) {
      const salaId = interaction.customId.replace('votar_sim_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando || !sala.votacao.ativa) return interaction.reply({ content: t(userId, 'resp_votacao_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(userId)) return interaction.reply({ content: t(userId, 'resp_nao_na_sala'), flags: MessageFlags.Ephemeral });

      const trocou = sala.votacao.nao.has(userId);
      sala.votacao.sim.add(userId);
      sala.votacao.nao.delete(userId);

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
          if (votMsg) await votMsg.edit({ content: t(sala.criadorId, 'msg_votacao_aprovada'), embeds: [], components: [] });
        }
        await interaction.reply({ content: t(userId, 'resp_votacao_aprovada'), flags: MessageFlags.Ephemeral });
        await agendarFechamento(salaId, guild, 'votação (maioria)');
        return;
      }

      salvarEstado();
      const feedback = trocou ? t(userId, 'resp_voto_sim_trocou') : t(userId, 'resp_voto_sim');
      await interaction.reply({ content: feedback, flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  VOTAR NAO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('votar_nao_')) {
      const salaId = interaction.customId.replace('votar_nao_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando || !sala.votacao.ativa) return interaction.reply({ content: t(userId, 'resp_votacao_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (!sala.membros.has(userId)) return interaction.reply({ content: t(userId, 'resp_nao_na_sala'), flags: MessageFlags.Ephemeral });

      const trocou = sala.votacao.sim.has(userId);
      sala.votacao.nao.add(userId);
      sala.votacao.sim.delete(userId);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && sala.votacao.messageId) {
        const votMsg = await textCh.messages.fetch(sala.votacao.messageId).catch(() => null);
        if (votMsg) await votMsg.edit({ embeds: [buildVotacaoEmbed(sala)], components: [buildVotacaoBotoes(salaId)] });
      }

      salvarEstado();
      const feedback = trocou ? t(userId, 'resp_voto_nao_trocou') : t(userId, 'resp_voto_nao');
      await interaction.reply({ content: feedback, flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  CANCELAR VOTACAO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('votar_cancelar_')) {
      const salaId = interaction.customId.replace('votar_cancelar_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || !sala.votacao.ativa) return interaction.reply({ content: t(userId, 'resp_nenhuma_votacao'), flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== userId) return interaction.reply({ content: t(userId, 'resp_apenas_lider_cancelar'), flags: MessageFlags.Ephemeral });

      const oldMsgId = sala.votacao.messageId;
      cancelarVotacaoTimeout(salaId);
      sala.votacao = { ativa: false, sim: new Set(), nao: new Set(), messageId: null, iniciadaEm: null };

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh && oldMsgId) {
        const votMsg = await textCh.messages.fetch(oldMsgId).catch(() => null);
        if (votMsg) await votMsg.edit({ content: t(sala.criadorId, 'msg_votacao_cancelada'), embeds: [], components: [] }).catch(() => {});
      }

      salvarEstado();
      await interaction.reply({ content: t(userId, 'resp_votacao_cancelada'), flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  TOGGLE ANDAMENTO (lider)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('toggle_andamento_')) {
      const salaId = interaction.customId.replace('toggle_andamento_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== userId) return interaction.reply({ content: t(userId, 'resp_apenas_lider'), flags: MessageFlags.Ephemeral });

      sala.emAndamento = !sala.emAndamento;
      const status = sala.emAndamento ? t(userId, 'msg_partida_iniciada') : t(userId, 'msg_partida_pausada');

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.send(`${status} Por <@${userId}>`).catch(() => {});

      salvarEstado();
      await interaction.reply({ content: `✅ ${status}`, flags: MessageFlags.Ephemeral });
      return;
    }

    // ══════════════════════════════════════════
    //  ALTERAR CODIGO (lider)
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('alterar_codigo_')) {
      const salaId = interaction.customId.replace('alterar_codigo_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== userId) return interaction.reply({ content: t(userId, 'resp_apenas_lider'), flags: MessageFlags.Ephemeral });

      const modal = new ModalBuilder()
        .setCustomId(`modal_alterar_codigo_${salaId}`)
        .setTitle(t(userId, 'modal_alterar_titulo'));
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('novo_codigo').setLabel(t(userId, 'modal_alterar_codigo')).setStyle(TextInputStyle.Short).setPlaceholder(sala.codigo).setMaxLength(20).setRequired(true)
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
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== userId) return interaction.reply({ content: t(userId, 'resp_apenas_lider'), flags: MessageFlags.Ephemeral });

      const membros = [...sala.membros].filter(id => id !== sala.criadorId);
      if (membros.length === 0) return interaction.reply({ content: t(userId, 'resp_sem_outros_membros'), flags: MessageFlags.Ephemeral });

      const options = membros.slice(0, 25).map(id => {
        const member = guild.members.cache.get(id);
        return { label: (member?.displayName || `User ${id}`).substring(0, 100), value: id };
      });

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`select_novo_lider_${salaId}`)
          .setPlaceholder(t(userId, 'select_lider_placeholder'))
          .addOptions(options)
      );

      return interaction.reply({ content: t(userId, 'resp_selecione_lider'), components: [row], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  SELECT: NOVO LIDER
    // ══════════════════════════════════════════
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_novo_lider_')) {
      const salaId = interaction.customId.replace('select_novo_lider_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.update({ content: t(userId, 'resp_sala_nao_encontrada'), components: [] });
      if (sala.criadorId !== userId) return interaction.update({ content: t(userId, 'resp_nao_mais_lider'), components: [] });

      const novoLiderId = interaction.values[0];
      if (!sala.membros.has(novoLiderId)) return interaction.update({ content: t(userId, 'resp_membro_saiu_select'), components: [] });

      sala.criadorId = novoLiderId;
      salvarEstado();

      await atualizarEmbedPublico(salaId, guild);
      await atualizarEmbedPrivado(salaId, guild);

      const textCh = guild.channels.cache.get(sala.textChannelId);
      if (textCh) await textCh.send(t(novoLiderId, 'msg_lideranca_transferida', { de: userId, para: novoLiderId })).catch(() => {});

      await interaction.update({ content: t(userId, 'resp_lideranca_transferida', { user: novoLiderId }), components: [] });
      logger.info(`Lideranca transferida na sala ${salaId}: ${userId} -> ${novoLiderId}`);
      return;
    }

    // ══════════════════════════════════════════
    //  ENCERRAR PARTIDA (lider) — com confirmacao
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('encerrar_partida_')) {
      const salaId = interaction.customId.replace('encerrar_partida_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== userId) return interaction.reply({ content: t(userId, 'resp_apenas_lider'), flags: MessageFlags.Ephemeral });
      return interaction.reply(buildConfirmacao('encerrar', salaId, sala.membros.size, userId));
    }

    // ══════════════════════════════════════════
    //  FORCAR FECHAR (lider) — com confirmacao
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('forcar_fechar_')) {
      const salaId = interaction.customId.replace('forcar_fechar_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      if (sala.criadorId !== userId) return interaction.reply({ content: t(userId, 'resp_apenas_lider'), flags: MessageFlags.Ephemeral });
      return interaction.reply(buildConfirmacao('fechar', salaId, sala.membros.size, userId));
    }

    // ══════════════════════════════════════════
    //  CONFIRMAR ENCERRAR
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('confirmar_encerrar_')) {
      const salaId = interaction.customId.replace('confirmar_encerrar_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.update({ content: t(userId, 'resp_sala_sendo_fechada'), embeds: [], components: [] });
      await interaction.update({ content: t(userId, 'resp_encerrando', { segundos: CLOSE_DELAY_SEC }), embeds: [], components: [] });
      await agendarFechamento(salaId, guild, `encerrada pelo líder (<@${userId}>)`);
      return;
    }

    // ══════════════════════════════════════════
    //  CONFIRMAR FECHAR
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('confirmar_fechar_')) {
      const salaId = interaction.customId.replace('confirmar_fechar_', '');
      const sala = salas.get(salaId);
      const userId = interaction.user.id;
      if (!sala || sala.fechando) return interaction.update({ content: t(userId, 'resp_sala_sendo_fechada'), embeds: [], components: [] });
      await interaction.update({ content: t(userId, 'resp_fechando', { segundos: CLOSE_DELAY_SEC }), embeds: [], components: [] });
      await agendarFechamento(salaId, guild, `criador (<@${userId}>)`);
      return;
    }

    // ══════════════════════════════════════════
    //  CANCELAR ACAO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId.startsWith('cancelar_acao_')) {
      const userId = interaction.user.id;
      return interaction.update({ content: t(userId, 'resp_acao_cancelada'), embeds: [], components: [] });
    }

    // ══════════════════════════════════════════
    //  ADMIN: REFRESH
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_refresh') {
      const userId = interaction.user.id;
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: t(userId, 'resp_sem_permissao'), flags: MessageFlags.Ephemeral });
      await atualizarPainelAdmin(guild);
      return interaction.reply({ content: t(userId, 'resp_atualizado'), flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  ADMIN: FECHAR TODAS
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_delete_all') {
      const userId = interaction.user.id;
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: t(userId, 'resp_sem_permissao'), flags: MessageFlags.Ephemeral });
      const ids = Array.from(salas.keys()).filter(id => !salas.get(id).fechando);
      if (ids.length === 0) return interaction.reply({ content: t(userId, 'resp_nenhuma_sala_ativa'), flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: t(userId, 'resp_fechando_salas', { count: ids.length }), flags: MessageFlags.Ephemeral });
      for (const id of ids) await agendarFechamento(id, guild, `admin (<@${userId}>)`);
      return;
    }

    // ══════════════════════════════════════════
    //  ADMIN: LIMPAR ORFAOS
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_cleanup_orfaos') {
      const userId = interaction.user.id;
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: t(userId, 'resp_sem_permissao'), flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const n = await limparOrfaos(guild);
      return interaction.editReply({ content: t(userId, 'resp_orfaos_removidos', { count: n }) });
    }

    // ══════════════════════════════════════════
    //  ADMIN: HISTORICO
    // ══════════════════════════════════════════
    if (interaction.isButton() && interaction.customId === 'admin_historico') {
      const userId = interaction.user.id;
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: t(userId, 'resp_sem_permissao'), flags: MessageFlags.Ephemeral });

      const historico = carregarHistorico(10);
      if (historico.length === 0) {
        return interaction.reply({ content: t(userId, 'resp_sem_historico_admin'), flags: MessageFlags.Ephemeral });
      }

      const lista = historico.reverse().map((h, i) => {
        const duracao = h.fechadoEm && h.criadoEm ? Math.round((h.fechadoEm - h.criadoEm) / 60) : '?';
        return `**${i + 1}.** 🎮 **${h.nome}** — ${h.membros} jogadores — ${duracao} min\n   └ Líder: <@${h.criadorId}> | Motivo: ${h.motivo}`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x7B2FBE)
        .setTitle(t(userId, 'embed_historico_admin_titulo'))
        .setDescription(lista.substring(0, 4000))
        .setFooter({ text: t(userId, 'historico_footer_admin', { total: carregarHistorico(200).length }) });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ══════════════════════════════════════════
    //  ADMIN: SELECT SALA
    // ══════════════════════════════════════════
    if (interaction.isStringSelectMenu() && interaction.customId === 'admin_select_sala') {
      const userId = interaction.user.id;
      if (!ehAdmin(interaction.member)) return interaction.reply({ content: t(userId, 'resp_sem_permissao'), flags: MessageFlags.Ephemeral });
      const salaId = interaction.values[0];
      const sala = salas.get(salaId);
      if (!sala || sala.fechando) return interaction.reply({ content: t(userId, 'resp_sala_nao_encontrada'), flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: `🗑️ Fechando **${sala.nome}**...`, flags: MessageFlags.Ephemeral });
      await agendarFechamento(salaId, guild, `admin (<@${interaction.user.id}>)`);
      return;
    }

  } catch (error) {
    logger.error(`Erro interacao ${interaction?.customId || 'desconhecida'}: ${error.stack || error.message}`);
    try {
      const userId = interaction?.user?.id;
      const errMsg = t(userId, 'resp_erro_interno');
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.followUp({ content: errMsg, flags: MessageFlags.Ephemeral });
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
