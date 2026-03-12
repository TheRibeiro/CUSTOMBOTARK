# 🎮 ARKHERON SA — Custom Game Bot

Bot que gerencia salas de custom game em tempo real no Discord.

---

## 📋 PASSO A PASSO COMPLETO

### PARTE 1 — Criar um novo Bot no Discord

> ⚠️ Crie um bot SEPARADO do bot de setup. Este precisa ficar online 24/7.

1. Acesse: https://discord.com/developers/applications
2. Clique em **"New Application"** → Nome: `Arkheron Custom Game`
3. Vá em **"Bot"** → clique em **"Add Bot"**
4. Copie o **TOKEN** e guarde
5. Em **Privileged Gateway Intents**, ative:
   - ✅ SERVER MEMBERS INTENT
   - ✅ MESSAGE CONTENT INTENT
6. Salve

### PARTE 2 — Convidar o Bot

1. Vá em **OAuth2 → URL Generator**
2. Marque: `bot`
3. Permissões: ✅ **Administrator**
4. Cole a URL no navegador e adicione ao servidor **Arkheron SA**

### PARTE 3 — Pegar os IDs necessários

> Com o **Modo Desenvolvedor** ativado (Configurações → Avançado):

- **GUILD_ID** → botão direito no servidor → Copiar ID
- **LOG_CHANNEL_ID** → botão direito no canal #logs → Copiar ID
- **MIN_ROLE_ID** → Configurações do Servidor → Cargos → clique em 🎮 Jogador → Copiar ID do Cargo

### PARTE 4 — Configurar o .env

Abra o arquivo `.env` e preencha:

```
DISCORD_TOKEN=seu_token_aqui
GUILD_ID=id_do_servidor
LOG_CHANNEL_ID=id_do_canal_logs
MIN_ROLE_ID=id_do_cargo_jogador
```

> Deixe SALAS_CHANNEL_ID e CUSTOM_CATEGORY_ID em branco por enquanto.

### PARTE 5 — Criar os canais automaticamente

Na pasta do bot, abra o terminal e rode:

```
npm install
node setup_canais.js
```

O script vai criar a categoria e os canais e mostrar os IDs no terminal.
**Copie os IDs** e cole no `.env`:

```
SALAS_CHANNEL_ID=id_mostrado_no_terminal
CUSTOM_CATEGORY_ID=id_mostrado_no_terminal
```

### PARTE 6 — Testar localmente

```
node index.js
```

Se aparecer `✅ Custom Game Bot online`, está funcionando!
Vá no canal #salas do Discord e veja o painel aparecer.

---

## ☁️ HOSPEDAGEM — Railway (recomendado, gratuito)

### Por que Railway?
- Gratuito para bots pequenos
- Fácil de configurar
- Bot fica online 24/7

### Passo a passo Railway

1. Acesse: https://railway.app
2. Clique em **"Login"** → faça login com o **GitHub**
   - Se não tiver conta no GitHub, crie em github.com (é grátis)
3. No Railway, clique em **"New Project"**
4. Selecione **"Deploy from GitHub repo"**
5. Clique em **"Configure GitHub App"** e autorize
6. Selecione o repositório do bot
   - Se não tiver o código no GitHub ainda, veja abaixo como subir

### Como subir o código no GitHub

1. Acesse: github.com e crie uma conta se não tiver
2. Clique em **"New repository"**
3. Nome: `arkheron-custom-bot` → **Private** → Create
4. Baixe o GitHub Desktop: desktop.github.com
5. Faça login e clone o repositório vazio
6. Copie os arquivos do bot para a pasta clonada:
   - `index.js`
   - `package.json`
   - `.env` ⚠️ NÃO suba o .env! Veja abaixo.
7. Commit e Push pelo GitHub Desktop

> ⚠️ NUNCA suba o arquivo .env para o GitHub. Ele contém seu token.

### Configurar variáveis de ambiente no Railway

1. No Railway, após conectar o repositório, vá em **"Variables"**
2. Adicione cada variável do seu .env:
   - `DISCORD_TOKEN` = seu token
   - `GUILD_ID` = id do servidor
   - `SALAS_CHANNEL_ID` = id do canal
   - `CUSTOM_CATEGORY_ID` = id da categoria
   - `LOG_CHANNEL_ID` = id do canal de logs
   - `MIN_ROLE_ID` = id do cargo jogador
3. Clique em **"Deploy"**
4. O Railway vai instalar as dependências e iniciar o bot automaticamente

### Verificar se está rodando

- No Railway, clique em **"Deployments"**
- Você vai ver o log em tempo real
- Se aparecer `✅ Custom Game Bot online`, está tudo certo!

---

## 🔄 Como atualizar o bot depois

1. Edite os arquivos localmente
2. Faça Commit e Push pelo GitHub Desktop
3. O Railway detecta automaticamente e faz o redeploy

---

## ❓ Problemas comuns

| Problema | Solução |
|---|---|
| Bot não aparece online | Verifique o TOKEN no Railway Variables |
| Painel não aparece no #salas | Verifique o SALAS_CHANNEL_ID |
| Erro ao criar sala | Verifique o CUSTOM_CATEGORY_ID e permissões do bot |
| Cargo não verificado | Verifique o MIN_ROLE_ID |
