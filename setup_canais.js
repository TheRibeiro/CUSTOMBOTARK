// ============================================================
//  🗼 ARKHERON SA — Setup dos Canais de Custom Game
//  Rode UMA VEZ para criar os canais necessários
// ============================================================

require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ Conectado como ${client.user.tag}`);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) { console.error('❌ Servidor não encontrado!'); process.exit(1); }

  // Cria categoria CUSTOM GAME
  console.log('\n📁 Criando categoria CUSTOM GAME...');
  const categoria = await guild.channels.create({
    name: '🎮 CUSTOM GAME',
    type: ChannelType.GuildCategory,
  });

  // Canal #como-funciona (readonly)
  const comoFunciona = await guild.channels.create({
    name: '📢・como-funciona',
    type: ChannelType.GuildText,
    parent: categoria.id,
    topic: 'Como funciona o sistema de custom game',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel] }
    ],
  });

  // Canal #salas (onde o bot vai postar as salas)
  const salas = await guild.channels.create({
    name: '🎮・salas',
    type: ChannelType.GuildText,
    parent: categoria.id,
    topic: 'Salas de custom game ativas',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel] }
    ],
  });

  // Posta mensagem de como funciona
  await comoFunciona.send(`
📢 **COMO FUNCIONA O CUSTOM GAME**

**1️⃣ Criar uma sala**
Vá em 🎮・salas e clique em **"🎮 Criar Sala"**.
Preencha o nome, o código do lobby e o número de vagas.

**2️⃣ Entrar em uma sala**
As salas ativas aparecem no canal em tempo real.
Clique em **"✅ Entrar na Sala"** para entrar.
Você vai receber acesso a um **chat privado** e um **canal de voz** exclusivos da sala.

**3️⃣ Durante o jogo**
O código do lobby fica visível **somente dentro da sala privada**.
Use o canal de voz para se comunicar com o time.

**4️⃣ Ao terminar a partida**
Clique em **"🏁 Partida Acabou"** para iniciar uma votação.
Com **mínimo de 8 votos** (ou maioria) em Sim, a sala é fechada automaticamente.
O criador pode fechar a sala a qualquer momento com **"🗑️ Fechar Sala"**.

*⚠️ Apenas membros com cargo 🎮 Jogador ou superior podem criar salas.*
  `);

  console.log('\n✅ Canais criados com sucesso!');
  console.log('\n📋 ANOTE ESSES IDs NO SEU .env:');
  console.log(`SALAS_CHANNEL_ID=${salas.id}`);
  console.log(`CUSTOM_CATEGORY_ID=${categoria.id}`);
  console.log('\nDepois rode: node index.js');

  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Token inválido:', err.message);
  process.exit(1);
});
