// ============================================================
//  🗼 ARKHERON SA — Setup do Canal de Administração
//  Rode UMA VEZ para criar o canal de admin
// ============================================================

require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Conectado como ${client.user.tag}`);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) { console.error('❌ Servidor não encontrado!'); process.exit(1); }

  // Busca a categoria CUSTOM GAME
  const categoria = guild.channels.cache.get(process.env.CUSTOM_CATEGORY_ID);
  if (!categoria) {
    console.error('❌ Categoria CUSTOM GAME não encontrada! Rode setup_canais.js primeiro.');
    process.exit(1);
  }

  // Busca cargos de admin
  const adminRoles = guild.roles.cache.filter(r =>
    ['👑 Dono', '⚙️ Admin', '🛡️ Moderador'].includes(r.name)
  );

  if (adminRoles.size === 0) {
    console.log('⚠️ Nenhum cargo de admin encontrado. O canal será privado apenas para o bot.');
  }

  // Permissões base - invisível para todos
  const permissoes = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
  ];

  // Adiciona permissões para cada cargo de admin
  for (const [, role] of adminRoles) {
    permissoes.push({
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
  }

  console.log('\n📁 Criando canal de administração...');
  const adminChannel = await guild.channels.create({
    name: '🛡️・admin-salas',
    type: ChannelType.GuildText,
    parent: categoria.id,
    topic: 'Painel de administração das salas de custom game - Apenas para staff',
    permissionOverwrites: permissoes,
  });

  // Posta mensagem de boas-vindas
  await adminChannel.send(`
🛡️ **PAINEL DE ADMINISTRAÇÃO — SALAS DE CUSTOM GAME**

Este canal permite que administradores gerenciem todas as salas ativas:

**🔧 Funções disponíveis:**
• Visualizar todas as salas ativas em tempo real
• Deletar salas específicas (usando o menu)
• Fechar todas as salas de uma vez (botão vermelho)
• Atualizar a lista de salas (botão azul)

**⚠️ Acesso restrito a:**
👑 Dono | ⚙️ Admin | 🛡️ Moderador

*O painel será enviado automaticamente quando o bot iniciar.*
  `);

  console.log('\n✅ Canal de administração criado com sucesso!');
  console.log('\n📋 ADICIONE ESTE ID NO SEU .env:');
  console.log(`ADMIN_SALAS_CHANNEL_ID=${adminChannel.id}`);
  console.log('\nDepois rode: node index.js');

  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Token inválido:', err.message);
  process.exit(1);
});
