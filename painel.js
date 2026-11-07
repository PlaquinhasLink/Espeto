/* ==========================================================================
   PAINEL DE PEDIDOS — lógica (não precisa editar; a configuração está em config.js)
   Fala com o Supabase direto pela API REST (sem biblioteca):
     - login:      POST  /auth/v1/token
     - lista:      GET   /rest/v1/pedidos      (a cada PAINEL.intervaloSegundos)
     - relatórios: GET   /rest/v1/pedidos?criado_em=gte.…&criado_em=lt.…
     - status/pagamento: PATCH /rest/v1/pedidos?id=eq.<id>   (ou id=in.(a,b) ao fechar a conta)
   Seções: Pedidos · Mesas (fechar conta) · Caixa · Mais vendidos · Histórico
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------------- */
  /* Utilitários                                                            */
  /* ---------------------------------------------------------------------- */
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const hora = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const dataHora = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const soma = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  const r2 = (n) => Math.round(n * 100) / 100;

  const BASE = String(PAINEL.supabaseUrl || "").replace(/\/+$/, "");
  const KEY = PAINEL.anonKey || "";
  const INTERVALO = Math.max(2, Number(PAINEL.intervaloSegundos) || 5) * 1000;
  const ALERTA_MIN = Number(PAINEL.alertaMinutos) || 15;
  const VIRADA = Number.isFinite(Number(PAINEL.viradaDiaHora)) && PAINEL.viradaDiaHora !== "" ? Number(PAINEL.viradaDiaHora) : 5;
  const FORMAS = Array.isArray(PAINEL.formasPagamento) && PAINEL.formasPagamento.length ? PAINEL.formasPagamento : ["Pix", "Dinheiro", "Cartão de crédito", "Cartão de débito"];
  const LS_SESSAO = "painel:sessao:v1";
  const LS_SOM = "painel:som:v1";
  const LS_IMP = "painel:autoimp:v1";

  const ATIVOS = ["novo", "preparo", "pronto"];
  const COLUNAS = [
    { status: "novo", titulo: "Novos" },
    { status: "preparo", titulo: "Em preparo" },
    { status: "pronto", titulo: "Prontos" }
  ];
  const ROTULO = { novo: "Novo", preparo: "Em preparo", pronto: "Pronto", entregue: "Entregue", cancelado: "Cancelado" };
  const ROTULO_TIPO = { local: "No local", entrega: "Entrega", retirada: "Retirada" };
  const AVANCAR = { novo: ["preparo", "Iniciar preparo"], preparo: ["pronto", "Marcar pronto"], pronto: ["entregue", "Entregue"] };

  const lerLS = (k, f) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } };
  const gravarLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignora */ } };
  const apagarLS = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignora */ } };

  /* ---- datas no fuso de São Paulo (sem horário de verão desde 2019: UTC-3 fixo) ---- */
  const pad = (n) => String(n).padStart(2, "0");
  function somaDias(ymd, n) {
    const p = ymd.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }
  function diaTrabalhoHoje() {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const g = {}; f.forEach((x) => { g[x.type] = x.value; });
    const ymd = g.year + "-" + g.month + "-" + g.day;
    return Number(g.hour) < VIRADA ? somaDias(ymd, -1) : ymd;
  }
  const inicioDia = (ymd) => new Date(ymd + "T" + pad(VIRADA) + ":00:00-03:00");
  const fimDia = (ymd) => inicioDia(somaDias(ymd, 1));
  const dataBR = (ymd) => ymd.split("-").reverse().join("/");
  const ymdValido = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

  /* ---------------------------------------------------------------------- */
  /* Estado                                                                 */
  /* ---------------------------------------------------------------------- */
  let sessao = lerLS(LS_SESSAO, null);   // { access, refresh, expira }
  let pedidos = new Map();               // últimos pedidos (atualiza sozinho)
  let primeiraCarga = true;
  let visao = "pedidos";
  let aba = "ativos";
  let filtro = "todos";
  let timer = null;
  let renovando = null;
  let piscando = new Set();
  let assinatura = "";

  const cx = { dia: null, dados: null, erro: "", carregando: false };
  const rk = { dias: 7, ord: "qtd", dados: null, erro: "", carregando: false };
  const hs = { de: null, ate: null, dados: null, erro: "", carregando: false, f: { mesa: "", min: "", max: "", tipo: "", pgto: "", busca: "" } };

  /* ---------------------------------------------------------------------- */
  /* API                                                                    */
  /* ---------------------------------------------------------------------- */
  async function http(path, opts) {
    opts = opts || {};
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const headers = Object.assign({ apikey: KEY, "Content-Type": "application/json" }, opts.headers || {});
      return await fetch(BASE + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctl.signal
      });
    } finally {
      clearTimeout(t);
    }
  }

  function guardarSessao(j) {
    sessao = { access: j.access_token, refresh: j.refresh_token, expira: Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000 };
    gravarLS(LS_SESSAO, sessao);
  }

  async function renovar() {
    if (renovando) return renovando;
    renovando = (async () => {
      try {
        if (!sessao || !sessao.refresh) throw new Error("sessao");
        const r = await http("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: sessao.refresh } });
        if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error("sessao");
        if (!r.ok) throw new Error("http " + r.status);
        guardarSessao(await r.json());
      } finally {
        renovando = null;
      }
    })();
    return renovando;
  }

  // chamada autenticada: renova o token quando expira e tenta de novo se vier 401
  async function autenticado(path, opts) {
    if (!sessao) throw new Error("sessao");
    if (Date.now() >= sessao.expira) await renovar();
    const montar = () => Object.assign({}, opts, { headers: Object.assign({}, (opts || {}).headers, { Authorization: "Bearer " + sessao.access }) });
    let r = await http(path, montar());
    if (r.status === 401) {
      await renovar();
      r = await http(path, montar());
    }
    return r;
  }

  async function buscar() {
    const r = await autenticado("/rest/v1/pedidos?select=*&order=criado_em.desc&limit=300");
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }

  // pedidos de um período (de <= criado_em < ate), em páginas de 1000
  async function buscarPeriodo(de, ate) {
    let todos = [];
    for (let off = 0; off < 10000; off += 1000) {
      const q = "/rest/v1/pedidos?select=*&criado_em=gte." + encodeURIComponent(de.toISOString()) +
        "&criado_em=lt." + encodeURIComponent(ate.toISOString()) + "&order=criado_em.desc&limit=1000&offset=" + off;
      const r = await autenticado(q);
      if (!r.ok) throw new Error("http " + r.status);
      const l = await r.json();
      todos = todos.concat(l);
      if (l.length < 1000) break;
    }
    return todos;
  }

  /* ---------------------------------------------------------------------- */
  /* Som e alertas                                                          */
  /* ---------------------------------------------------------------------- */
  let audio = null;
  let somLigado = lerLS(LS_SOM, "on") !== "off";

  function destravarAudio() {
    try {
      if (!audio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audio = new AC(); }
      if (audio && audio.state === "suspended") audio.resume();
    } catch (e) { /* sem áudio */ }
  }
  function audioPronto() { return !!audio && audio.state === "running"; }

  function bip() {
    if (!somLigado || !audioPronto()) return;
    [880, 1175, 880].forEach((freq, i) => {
      const t0 = audio.currentTime + i * 0.22;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0);
      osc.stop(t0 + 0.22);
    });
  }

  function atualizarBotaoSom() {
    const b = $("#btnSom");
    if (!somLigado) b.textContent = "🔕 Som desligado";
    else if (audioPronto()) b.textContent = "🔔 Som ligado";
    else b.textContent = "🔔 Toque para ativar o som";
  }

  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms || 2600);
  }

  /* ---------------------------------------------------------------------- */
  /* Impressão (cupom 80 mm) e impressão automática                          */
  /* ---------------------------------------------------------------------- */
  let autoImp = lerLS(LS_IMP, "off") === "on";
  const filaImp = [];
  let imprimindo = false;

  function atualizarBotaoImp() {
    $("#btnImp").textContent = "🖨️ Auto-impressão: " + (autoImp ? "ligada" : "desligada");
    $("#btnImp").classList.toggle("is-on", autoImp);
  }

  function linhasItens(itens) {
    return (Array.isArray(itens) ? itens : []).map((i) =>
      '<div class="l"><span>' + esc(i.qtd) + "x " + esc(i.nome) + "</span><span>" + brl(i.total) + "</span></div>" +
      (Array.isArray(i.opcoes) ? i.opcoes.map((o) => '<div class="sub">' + esc(o) + "</div>").join("") : "") +
      (i.obs ? '<div class="sub">Obs: ' + esc(i.obs) + "</div>" : "")
    ).join("");
  }

  function imprimirHTML(html) {
    $("#ticket").innerHTML = html;
    window.print();
  }

  function imprimir(p) {
    imprimirHTML(
      "<h2>" + esc(PAINEL.nome || "Pedido") + "</h2>" +
      '<div class="grande">' + (p.tipo === "local" ? "MESA " + esc(p.mesa) : p.tipo === "retirada" ? "RETIRADA" : "ENTREGA") + "</div>" +
      '<div class="l"><span>Pedido #' + esc(p.numero) + "</span><span>" + esc(dataHora(p.criado_em)) + "</span></div><hr>" +
      linhasItens(p.itens) + "<hr>" +
      (p.observacao ? "<div>Obs: " + esc(p.observacao) + "</div><hr>" : "") +
      (p.taxa_entrega ? '<div class="l"><span>Taxa de entrega</span><span>' + brl(p.taxa_entrega) + "</span></div>" : "") +
      '<div class="l"><strong>TOTAL</strong><strong>' + brl(p.total) + "</strong></div>" +
      "<div>Pagamento: " + esc(p.forma_pagamento) + "</div>"
    );
  }

  function enfileirarImpressao(p) {
    filaImp.push(p);
    if (!imprimindo) proximaImpressao();
  }
  function proximaImpressao() {
    const p = filaImp.shift();
    if (!p) { imprimindo = false; return; }
    imprimindo = true;
    try { imprimir(p); } catch (e) { /* ignora */ }
    setTimeout(proximaImpressao, 1200);
  }

  /* ---------------------------------------------------------------------- */
  /* Pedidos (quadro)                                                       */
  /* ---------------------------------------------------------------------- */
  const minutos = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  function textoTempo(iso) {
    const m = minutos(iso);
    if (m < 1) return "agora";
    if (m < 60) return "há " + m + " min";
    return "há " + Math.floor(m / 60) + " h " + (m % 60 ? (m % 60) + " min" : "");
  }

  function tipoHTML(p) {
    if (p.tipo === "local") return '<span class="tipo tipo--local">🍽️ Mesa ' + esc(p.mesa) + "</span>";
    if (p.tipo === "retirada") return '<span class="tipo">🏪 Retirada</span>';
    return '<span class="tipo">🛵 Entrega</span>';
  }

  function itensHTML(p) {
    const itens = Array.isArray(p.itens) ? p.itens : [];
    return (
      '<ul class="itens">' +
      itens.map((i) =>
        "<li><span class=\"q\">" + esc(i.qtd) + "×</span>" + esc(i.nome) +
          (Array.isArray(i.opcoes) && i.opcoes.length ? "<small>" + esc(i.opcoes.join(" · ")) + "</small>" : "") +
          (i.obs ? "<em>📝 " + esc(i.obs) + "</em>" : "") +
        "</li>").join("") +
      "</ul>"
    );
  }

  function cardHTML(p) {
    const ativo = ATIVOS.indexOf(p.status) >= 0;
    const atraso = (p.status === "novo" || p.status === "preparo") && minutos(p.criado_em) >= ALERTA_MIN;
    const prox = AVANCAR[p.status];
    const pago = !!p.pago_em;
    return (
      '<article class="pedido pedido--' + esc(p.status) + (piscando.has(p.id) ? " pedido--alerta" : "") + (atraso ? " pedido--atraso" : "") + '" data-id="' + esc(p.id) + '">' +
        '<div class="pedido__head">' +
          '<span class="num">#' + esc(p.numero) + "</span>" + tipoHTML(p) +
          (ativo ? "" : '<span class="status-tag status-tag--' + esc(p.status) + '">' + esc(ROTULO[p.status] || p.status) + "</span>") +
          '<span class="tempo" data-ts="' + esc(p.criado_em) + '">' + hora(p.criado_em) + " · " + textoTempo(p.criado_em) + "</span>" +
        "</div>" +
        (p.nome_cliente ? '<p class="aviso-wpp">Cliente: ' + esc(p.nome_cliente) + "</p>" : "") +
        itensHTML(p) +
        (p.observacao ? '<p class="nota">📝 ' + esc(p.observacao) + "</p>" : "") +
        (p.tipo !== "local" && !p.nome_cliente ? '<p class="aviso-wpp">Cliente e endereço: veja na conversa do WhatsApp.</p>' : "") +
        '<div class="pedido__foot"><span>' + esc(p.forma_pagamento) + (p.taxa_entrega ? " · taxa " + brl(p.taxa_entrega) : "") +
          (pago ? ' · <b class="pago">✅ Pago (' + esc(p.pago_forma) + ")</b>" : "") + "</span><strong>" + brl(p.total) + "</strong></div>" +
        '<div class="acoes">' +
          (prox ? '<button type="button" class="btn btn--main btn--' + esc(p.status) + '" data-act="avancar" data-id="' + esc(p.id) + '">' + prox[1] + "</button>" : "") +
          (!pago && p.status !== "cancelado" ? '<button type="button" class="btn btn--sm btn--receber" data-act="receber" data-id="' + esc(p.id) + '">💰 Receber</button>' : "") +
          (!ativo ? '<button type="button" class="btn btn--sm" data-act="reabrir" data-id="' + esc(p.id) + '">Reabrir</button>' : "") +
          '<button type="button" class="btn btn--sm" data-act="imprimir" data-id="' + esc(p.id) + '">🖨️ Imprimir</button>' +
          (pago ? '<button type="button" class="btn btn--sm" data-act="desfazer-pgto" data-id="' + esc(p.id) + '">Desfazer pagamento</button>' : "") +
          (ativo ? '<button type="button" class="btn btn--sm btn--perigo" data-act="cancelar" data-id="' + esc(p.id) + '">Cancelar</button>' : "") +
        "</div>" +
      "</article>"
    );
  }

  /* mesas com conta aberta: pedidos "no local" ainda não pagos e não cancelados */
  function mesasAbertas() {
    const m = new Map();
    pedidos.forEach((p) => {
      if (p.tipo === "local" && !p.pago_em && p.status !== "cancelado") {
        if (!m.has(p.mesa)) m.set(p.mesa, []);
        m.get(p.mesa).push(p);
      }
    });
    m.forEach((l) => l.sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em)));
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }

  function contadores() {
    const todos = Array.from(pedidos.values());
    const ativos = todos.filter((p) => ATIVOS.indexOf(p.status) >= 0);
    const finais = todos.filter((p) => ATIVOS.indexOf(p.status) < 0 && Date.now() - new Date(p.criado_em).getTime() < 24 * 3600 * 1000);
    $("#nAtivos").textContent = ativos.length;
    $("#nFinal").textContent = finais.length;
    $("#nMesas").textContent = mesasAbertas().length;
    const novos = ativos.filter((p) => p.status === "novo").length;
    document.title = (novos ? "(" + novos + ") " : "") + "Painel · " + (PAINEL.nome || "Pedidos");
    return { ativos, finais };
  }

  function renderPedidos(ativos, finais) {
    const passaFiltro = (p) => filtro === "todos" || p.tipo === filtro;
    const board = $("#board");
    if (aba === "ativos") {
      board.className = "board";
      board.innerHTML = COLUNAS.map((c) => {
        const lista = ativos.filter((p) => p.status === c.status && passaFiltro(p))
          .sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em)); // mais antigo primeiro
        return (
          '<section class="col col--' + c.status + '"><h2 class="col__head"><span>' + c.titulo + "</span><span>" + lista.length + "</span></h2>" +
          '<div class="col__list">' + (lista.length ? lista.map(cardHTML).join("") : '<p class="vazio">Nenhum pedido</p>') + "</div></section>"
        );
      }).join("");
    } else {
      board.className = "board board--lista";
      const lista = finais.filter(passaFiltro); // já vem do mais novo para o mais antigo
      board.innerHTML = lista.length ? lista.map(cardHTML).join("") : '<p class="vazio vazio--grande">Nenhum pedido finalizado nas últimas 24 horas.</p>';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Mesas: ver consumo e fechar a conta                                    */
  /* ---------------------------------------------------------------------- */
  function consolidar(lista) {
    const m = new Map();
    lista.forEach((p) => (Array.isArray(p.itens) ? p.itens : []).forEach((i) => {
      const op = Array.isArray(i.opcoes) ? i.opcoes.join(" · ") : "";
      const k = i.nome + "|" + op + "|" + (i.obs || "");
      if (!m.has(k)) m.set(k, { nome: i.nome, opcoes: op, obs: i.obs || "", qtd: 0, total: 0 });
      const x = m.get(k);
      x.qtd += Number(i.qtd) || 0;
      x.total += Number(i.total) || 0;
    }));
    return Array.from(m.values());
  }

  function renderMesas() {
    const v = $("#view");
    const mesas = mesasAbertas();
    if (!mesas.length) {
      v.innerHTML = '<div class="vhead"><h2>Mesas</h2></div><p class="vazio vazio--grande">Nenhuma mesa com conta aberta.<br><small>Os pedidos "No local" aparecem aqui até a conta ser fechada.</small></p>';
      return;
    }
    v.innerHTML =
      '<div class="vhead"><h2>Mesas com conta aberta</h2><span class="muted">Total em aberto: <b>' + brl(soma(mesas, (m) => soma(m[1], (p) => p.total))) + "</b></span></div>" +
      '<div class="mesas">' +
      mesas.map(([n, lista]) => {
        const total = soma(lista, (p) => p.total);
        const naCozinha = lista.filter((p) => p.status !== "entregue").length;
        return (
          '<article class="mesa" data-mesa="' + esc(n) + '">' +
            '<div class="mesa__head"><span class="mesa__n">🍽️ Mesa ' + esc(n) + '</span><span class="tempo">aberta ' + textoTempo(lista[0].criado_em) + "</span></div>" +
            '<ul class="itens">' + consolidar(lista).map((i) =>
              '<li><span class="q">' + esc(i.qtd) + "×</span>" + esc(i.nome) + '<span class="vl">' + brl(i.total) + "</span>" +
              (i.opcoes ? "<small>" + esc(i.opcoes) + "</small>" : "") + (i.obs ? "<em>📝 " + esc(i.obs) + "</em>" : "") + "</li>").join("") + "</ul>" +
            '<p class="aviso-wpp">' + lista.length + (lista.length === 1 ? " pedido" : " pedidos") + (naCozinha ? " · " + naCozinha + " ainda na cozinha/entrega" : " · todos entregues") + "</p>" +
            '<div class="pedido__foot"><span>Total da conta</span><strong class="mesa__total">' + brl(total) + "</strong></div>" +
            '<div class="acoes"><button type="button" class="btn btn--main btn--receber-main" data-act="fechar-mesa" data-mesa="' + esc(n) + '">💰 Fechar conta</button>' +
            '<button type="button" class="btn btn--sm" data-act="imprimir-conta" data-mesa="' + esc(n) + '">🖨️ Imprimir conta</button></div>' +
          "</article>"
        );
      }).join("") + "</div>";
  }

  function imprimirConta(n, lista) {
    imprimirHTML(
      "<h2>" + esc(PAINEL.nome || "Conta") + "</h2>" +
      '<div class="grande">CONTA · MESA ' + esc(n) + "</div>" +
      "<div>" + esc(dataHora(new Date().toISOString())) + "</div><hr>" +
      consolidar(lista).map((i) =>
        '<div class="l"><span>' + esc(i.qtd) + "x " + esc(i.nome) + "</span><span>" + brl(i.total) + "</span></div>" +
        (i.opcoes ? '<div class="sub">' + esc(i.opcoes) + "</div>" : "")).join("") +
      '<hr><div class="l"><strong>TOTAL</strong><strong>' + brl(soma(lista, (p) => p.total)) + "</strong></div>" +
      '<div class="sub">Não é documento fiscal.</div>'
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Receber pagamento (janela) — serve para mesa inteira ou um pedido      */
  /* ---------------------------------------------------------------------- */
  let pag = null;   // { ids, forma, total }

  function abrirPagamento(lista, titulo, resumo) {
    const ordenados = lista.slice().sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
    const padrao = FORMAS.indexOf(ordenados[0].forma_pagamento) >= 0 ? ordenados[0].forma_pagamento : null;
    pag = { ids: lista.map((p) => p.id), forma: padrao, total: r2(soma(lista, (p) => p.total)) };
    $("#mTitulo").textContent = titulo;
    $("#mResumo").textContent = resumo || "";
    $("#mTotal").textContent = brl(pag.total);
    $("#mFormas").innerHTML = FORMAS.map((f) =>
      '<button type="button" class="forma' + (f === pag.forma ? " is-on" : "") + '" data-forma="' + esc(f) + '" aria-pressed="' + (f === pag.forma) + '">' + esc(f) + "</button>").join("");
    $("#mOk").disabled = !pag.forma;
    $("#modal").hidden = false;
    const alvo = $(".forma.is-on") || $(".forma");
    if (alvo) alvo.focus();
  }

  function fecharModal() { $("#modal").hidden = true; pag = null; }

  // aplica (ou desfaz) o pagamento em todas as listas carregadas; devolve o estado anterior para poder voltar atrás
  function aplicarPago(ids, em, forma) {
    const set = new Set(ids);
    const antes = [];
    const tocar = (p) => {
      if (p && set.has(p.id)) { antes.push([p, p.pago_em, p.pago_forma]); p.pago_em = em; p.pago_forma = forma; }
    };
    pedidos.forEach(tocar);
    [cx.dados, hs.dados].forEach((l) => { if (Array.isArray(l)) l.forEach((p) => { if (!pedidos.has(p.id) || pedidos.get(p.id) !== p) tocar(p); }); });
    return antes;
  }
  const desfazerAplicacao = (antes) => antes.forEach((a) => { a[0].pago_em = a[1]; a[0].pago_forma = a[2]; });

  async function salvarPagamento(ids, em, forma) {
    const antes = aplicarPago(ids, em, forma);
    assinatura = "";
    refrescar();
    try {
      const r = await autenticado("/rest/v1/pedidos?id=in.(" + ids.map(encodeURIComponent).join(",") + ")", {
        method: "PATCH", body: { pago_em: em, pago_forma: forma }, headers: { Prefer: "return=representation" }
      });
      if (!r.ok) throw new Error("http " + r.status);
      const linhas = await r.json();
      if (!Array.isArray(linhas) || linhas.length !== ids.length) throw new Error("sem permissão");
      return true;
    } catch (e) {
      desfazerAplicacao(antes);
      assinatura = "";
      refrescar();
      if (e && e.message === "sessao") { sair("Sessão expirada. Entre novamente."); return false; }
      toast("Não foi possível salvar o pagamento. Confira a internet e tente de novo.", 4000);
      return false;
    }
  }

  async function confirmarPagamento() {
    if (!pag || !pag.forma) return;
    const { ids, forma, total } = pag;
    fecharModal();
    const ok = await salvarPagamento(ids, new Date().toISOString(), forma);
    if (ok) toast("Pago: " + brl(total) + " em " + forma + " ✔");
  }

  /* ---------------------------------------------------------------------- */
  /* Carregamento comum das seções de relatório                             */
  /* ---------------------------------------------------------------------- */
  function erroCarga(e) {
    if (e && e.message === "sessao") { sair("Sessão expirada. Entre novamente."); return ""; }
    return "Não foi possível carregar. Confira a internet e tente de novo.";
  }
  const carregandoHTML = '<p class="vazio vazio--grande">Carregando…</p>';
  const erroHTML = (msg, act) => '<p class="vazio vazio--grande">' + esc(msg) + '<br><button type="button" class="btn btn--sm" data-act="' + act + '">Tentar de novo</button></p>';
  const validos = (l) => l.filter((p) => p.status !== "cancelado");

  /* ---------------------------------------------------------------------- */
  /* Caixa do dia: resumo + fechamento                                      */
  /* ---------------------------------------------------------------------- */
  function resumir(lista) {
    const v = validos(lista);
    const canc = lista.filter((p) => p.status === "cancelado");
    const agrupar = (arr, chave, valor) => {
      const o = {};
      arr.forEach((p) => { const k = chave(p); if (!o[k]) o[k] = { n: 0, v: 0 }; o[k].n += 1; o[k].v = r2(o[k].v + Number(valor(p))); });
      return o;
    };
    const pagos = v.filter((p) => p.pago_em);
    const pendentes = v.filter((p) => !p.pago_em);
    return {
      n: v.length,
      total: r2(soma(v, (p) => p.total)),
      ticket: v.length ? r2(soma(v, (p) => p.total) / v.length) : 0,
      cancelados: { n: canc.length, v: r2(soma(canc, (p) => p.total)) },
      porForma: agrupar(v, (p) => p.forma_pagamento, (p) => p.total),
      porTipo: agrupar(v, (p) => p.tipo, (p) => p.total),
      recebido: agrupar(pagos, (p) => p.pago_forma, (p) => p.total),
      totalRecebido: r2(soma(pagos, (p) => p.total)),
      pendentes,
      totalPendente: r2(soma(pendentes, (p) => p.total))
    };
  }

  const ordenarFormas = (obj) => {
    const ks = Object.keys(obj);
    return ks.sort((a, b) => {
      const ia = FORMAS.indexOf(a), ib = FORMAS.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  };

  function tabelaValores(obj, rotulo, mapaRotulo) {
    const ks = ordenarFormas(obj);
    if (!ks.length) return '<p class="muted">Sem dados.</p>';
    return '<table class="tbl"><thead><tr><th>' + rotulo + '</th><th class="r">Pedidos</th><th class="r">Valor</th></tr></thead><tbody>' +
      ks.map((k) => "<tr><td>" + esc(mapaRotulo ? mapaRotulo[k] || k : k) + '</td><td class="r">' + obj[k].n + '</td><td class="r">' + brl(obj[k].v) + "</td></tr>").join("") +
      '</tbody><tfoot><tr><td>Total</td><td class="r">' + soma(ks, (k) => obj[k].n) + '</td><td class="r">' + brl(soma(ks, (k) => obj[k].v)) + "</td></tr></tfoot></table>";
  }

  function htmlCaixa() {
    const d = cx.dia;
    const esqueleto =
      '<div class="vhead"><h2>Caixa</h2><div class="dia">' +
      '<button type="button" class="btn btn--sm" data-act="cx-ant" aria-label="Dia anterior">‹</button>' +
      '<input type="date" id="cxDia" value="' + esc(d) + '" aria-label="Dia">' +
      '<button type="button" class="btn btn--sm" data-act="cx-prox" aria-label="Próximo dia">›</button>' +
      '<button type="button" class="btn btn--sm" data-act="cx-hoje">Hoje</button>' +
      '<button type="button" class="btn btn--sm" data-act="cx-atualizar">↻ Atualizar</button></div></div>' +
      '<p class="muted">Dia de trabalho: ' + dataBR(d) + " " + pad(VIRADA) + "h até " + dataBR(somaDias(d, 1)) + " " + pad(VIRADA) + "h (pedidos cancelados não entram nas somas)</p>";
    if (cx.carregando) return esqueleto + carregandoHTML;
    if (cx.erro) return esqueleto + erroHTML(cx.erro, "cx-atualizar");
    if (!cx.dados) return esqueleto;
    const r = resumir(cx.dados);
    const pend = r.pendentes.slice().sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
    return esqueleto +
      '<div class="stats">' +
        '<div class="stat"><span>Total vendido</span><b id="stTotal">' + brl(r.total) + "</b></div>" +
        '<div class="stat"><span>Pedidos</span><b id="stN">' + r.n + "</b></div>" +
        '<div class="stat"><span>Ticket médio</span><b id="stTicket">' + brl(r.ticket) + "</b></div>" +
        '<div class="stat stat--muted"><span>Cancelados</span><b>' + r.cancelados.n + " · " + brl(r.cancelados.v) + "</b></div>" +
      "</div>" +
      '<div class="duas">' +
        '<section class="bloco"><h3>Vendas por forma de pagamento</h3><p class="muted">Como o cliente escolheu pagar no pedido.</p>' + tabelaValores(r.porForma, "Forma") + "</section>" +
        '<section class="bloco"><h3>Vendas por tipo</h3>' + tabelaValores(r.porTipo, "Tipo", ROTULO_TIPO) + "</section>" +
      "</div>" +
      '<section class="bloco bloco--caixa"><div class="bloco__head"><h3>Fechamento do caixa</h3><button type="button" class="btn btn--sm" data-act="cx-imprimir">🖨️ Imprimir fechamento</button></div>' +
        '<p class="muted">O que realmente foi recebido (conferir com a gaveta, a maquininha e o Pix).</p>' +
        '<table class="tbl" id="cxRecebido"><thead><tr><th>Recebido em</th><th class="r">Pedidos</th><th class="r">Valor</th></tr></thead><tbody>' +
        (ordenarFormas(r.recebido).length ? ordenarFormas(r.recebido).map((k) => "<tr><td>" + esc(k) + '</td><td class="r">' + r.recebido[k].n + '</td><td class="r">' + brl(r.recebido[k].v) + "</td></tr>").join("") : '<tr><td colspan="3" class="muted">Nada recebido ainda.</td></tr>') +
        '</tbody><tfoot><tr><td>Total recebido</td><td></td><td class="r" id="cxTotalRec">' + brl(r.totalRecebido) + '</td></tr>' +
        '<tr class="' + (r.totalPendente ? "alerta" : "") + '"><td>A receber (ainda não baixado)</td><td class="r">' + r.pendentes.length + '</td><td class="r" id="cxTotalPend">' + brl(r.totalPendente) + "</td></tr></tfoot></table>" +
        (pend.length ? '<h4>Pedidos ainda não recebidos</h4><ul class="pend">' + pend.map((p) =>
          "<li><span>" + (p.tipo === "local" ? "🍽️ Mesa " + esc(p.mesa) : p.tipo === "retirada" ? "🏪 Retirada" : "🛵 Entrega") + " · #" + esc(p.numero) + " · " + hora(p.criado_em) +
          "</span><b>" + brl(p.total) + '</b><button type="button" class="btn btn--sm btn--receber" data-act="cx-receber" data-id="' + esc(p.id) + '">💰 Receber</button></li>').join("") + "</ul>" : "") +
      "</section>";
  }

  function renderCaixa() { $("#view").innerHTML = htmlCaixa(); }

  async function carregarCaixa() {
    cx.carregando = true; cx.erro = ""; renderCaixa();
    const dia = cx.dia;
    try {
      const dados = await buscarPeriodo(inicioDia(dia), fimDia(dia));
      if (visao !== "caixa" || cx.dia !== dia) return;
      cx.dados = dados;
    } catch (e) { cx.erro = erroCarga(e); }
    cx.carregando = false;
    if (visao === "caixa") renderCaixa();
  }

  function abrirCaixa() {
    if (!cx.dia) cx.dia = diaTrabalhoHoje();
    carregarCaixa();
  }

  function imprimirCaixa() {
    if (!cx.dados) return;
    const r = resumir(cx.dados);
    const lin = (a, b) => '<div class="l"><span>' + esc(a) + "</span><span>" + esc(b) + "</span></div>";
    imprimirHTML(
      "<h2>" + esc(PAINEL.nome || "Caixa") + "</h2>" +
      '<div class="grande">FECHAMENTO DO CAIXA</div>' +
      "<div>Dia de trabalho: " + dataBR(cx.dia) + "</div><div>Impresso: " + esc(dataHora(new Date().toISOString())) + "</div><hr>" +
      lin("Pedidos", r.n) + lin("Total vendido", brl(r.total)) + lin("Ticket médio", brl(r.ticket)) +
      lin("Cancelados", r.cancelados.n + " (" + brl(r.cancelados.v) + ")") + "<hr><div><strong>RECEBIDO</strong></div>" +
      (ordenarFormas(r.recebido).map((k) => lin(k + " (" + r.recebido[k].n + ")", brl(r.recebido[k].v))).join("") || "<div>Nada recebido</div>") +
      "<hr>" + lin("TOTAL RECEBIDO", brl(r.totalRecebido)) + lin("A RECEBER", brl(r.totalPendente)) + "<hr>" +
      "<div><strong>VENDAS POR PAGAMENTO (pedido)</strong></div>" +
      ordenarFormas(r.porForma).map((k) => lin(k + " (" + r.porForma[k].n + ")", brl(r.porForma[k].v))).join("")
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Mais vendidos                                                          */
  /* ---------------------------------------------------------------------- */
  function rankear(lista) {
    const m = new Map();
    validos(lista).forEach((p) => (Array.isArray(p.itens) ? p.itens : []).forEach((i) => {
      const k = String(i.nome);
      if (!m.has(k)) m.set(k, { nome: k, qtd: 0, total: 0 });
      const x = m.get(k);
      x.qtd += Number(i.qtd) || 0;
      x.total = r2(x.total + (Number(i.total) || 0));
    }));
    return Array.from(m.values());
  }

  function htmlRanking() {
    const hoje = diaTrabalhoHoje();
    const ini = somaDias(hoje, -(rk.dias - 1));
    const opt = [[1, "Hoje"], [7, "Últimos 7 dias"], [30, "Últimos 30 dias"]];
    const cab =
      '<div class="vhead"><h2>Mais vendidos</h2><div class="dia">' +
      '<select id="rkDias" aria-label="Período">' + opt.map((o) => '<option value="' + o[0] + '"' + (o[0] === rk.dias ? " selected" : "") + ">" + o[1] + "</option>").join("") + "</select>" +
      '<select id="rkOrd" aria-label="Ordenar por"><option value="qtd"' + (rk.ord === "qtd" ? " selected" : "") + '>Ordenar por quantidade</option><option value="total"' + (rk.ord === "total" ? " selected" : "") + ">Ordenar por faturamento</option></select>" +
      '<button type="button" class="btn btn--sm" data-act="rk-atualizar">↻ Atualizar</button></div></div>' +
      '<p class="muted">Período: ' + dataBR(ini) + " a " + dataBR(hoje) + " (cancelados não contam). Itens que nunca foram pedidos no período não aparecem aqui.</p>";
    if (rk.carregando) return cab + carregandoHTML;
    if (rk.erro) return cab + erroHTML(rk.erro, "rk-atualizar");
    if (!rk.dados) return cab;
    const lista = rankear(rk.dados).sort((a, b) => (b[rk.ord] - a[rk.ord]) || (b.qtd - a.qtd) || a.nome.localeCompare(b.nome));
    if (!lista.length) return cab + '<p class="vazio vazio--grande">Nenhuma venda no período.</p>';
    const max = lista[0][rk.ord] || 1;
    const totalGeral = soma(lista, (x) => x.total) || 1;
    const poucos = lista.length > 10 ? new Set(lista.slice(-5).map((x) => x.nome)) : new Set();
    return cab +
      '<table class="tbl tbl--rank" id="rkTabela"><thead><tr><th>#</th><th>Item</th><th class="r">Qtd</th><th class="r">Faturamento</th><th class="r">%</th></tr></thead><tbody>' +
      lista.map((x, i) =>
        "<tr" + (poucos.has(x.nome) ? ' class="pouco"' : "") + "><td>" + (i + 1) + "</td><td><div class=\"nm\">" + esc(x.nome) + (poucos.has(x.nome) ? ' <span class="tag-pouco">pouco vendido</span>' : "") +
        '</div><div class="barra"><i style="width:' + Math.max(2, Math.round((x[rk.ord] / max) * 100)) + '%"></i></div></td><td class="r">' + x.qtd + '</td><td class="r">' + brl(x.total) +
        '</td><td class="r">' + Math.round((x.total / totalGeral) * 100) + "%</td></tr>").join("") +
      "</tbody></table>";
  }

  function renderRanking() {
    const foco = document.activeElement && document.activeElement.id;
    $("#view").innerHTML = htmlRanking();
    if (foco && $("#" + foco)) $("#" + foco).focus();
  }

  async function carregarRanking() {
    rk.carregando = true; rk.erro = ""; renderRanking();
    const hoje = diaTrabalhoHoje();
    const dias = rk.dias;
    try {
      const dados = await buscarPeriodo(inicioDia(somaDias(hoje, -(dias - 1))), fimDia(hoje));
      if (visao !== "ranking" || rk.dias !== dias) return;
      rk.dados = dados;
    } catch (e) { rk.erro = erroCarga(e); }
    rk.carregando = false;
    if (visao === "ranking") renderRanking();
  }

  function abrirRanking() { carregarRanking(); }

  /* ---------------------------------------------------------------------- */
  /* Histórico com busca e exportação                                       */
  /* ---------------------------------------------------------------------- */
  const resumoItens = (p) => (Array.isArray(p.itens) ? p.itens : []).map((i) => i.qtd + "x " + i.nome + (Array.isArray(i.opcoes) && i.opcoes.length ? " (" + i.opcoes.join(", ") + ")" : "") + (i.obs ? " [" + i.obs + "]" : "")).join("; ");

  function filtrarHistorico() {
    const f = hs.f;
    const min = f.min === "" ? null : Number(String(f.min).replace(",", "."));
    const max = f.max === "" ? null : Number(String(f.max).replace(",", "."));
    const q = f.busca.trim().toLowerCase();
    return (hs.dados || []).filter((p) => {
      if (f.mesa !== "" && String(p.mesa) !== String(Number(f.mesa))) return false;
      if (min !== null && !isNaN(min) && Number(p.total) < min) return false;
      if (max !== null && !isNaN(max) && Number(p.total) > max) return false;
      if (f.tipo && p.tipo !== f.tipo) return false;
      if (f.pgto === "pago" && !p.pago_em) return false;
      if (f.pgto === "receber" && (p.pago_em || p.status === "cancelado")) return false;
      if (f.pgto === "cancelado" && p.status !== "cancelado") return false;
      if (q) {
        const alvo = (resumoItens(p) + " " + (p.observacao || "") + " " + (p.nome_cliente || "") + " " + (p.forma_pagamento || "") + " #" + p.numero).toLowerCase();
        if (alvo.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function htmlHistoricoLista() {
    if (hs.carregando) return carregandoHTML;
    if (hs.erro) return erroHTML(hs.erro, "hs-buscar");
    if (!hs.dados) return "";
    const lista = filtrarHistorico();
    if (!lista.length) return '<p class="vazio vazio--grande">Nenhum pedido encontrado com esses filtros.</p>';
    const MAX = 400;
    const mostrar = lista.slice(0, MAX);
    const validosL = validos(lista);
    return '<p class="muted" id="hsContagem"><b>' + lista.length + "</b> pedido(s) · soma (sem cancelados): <b>" + brl(soma(validosL, (p) => p.total)) + "</b>" +
      (lista.length > MAX ? " · mostrando os " + MAX + " mais recentes (a exportação leva todos)" : "") + "</p>" +
      '<div class="scroll-x"><table class="tbl tbl--hist"><thead><tr><th>#</th><th>Data e hora</th><th>Tipo</th><th>Itens</th><th class="r">Total</th><th>Pagamento</th><th>Status</th></tr></thead><tbody>' +
      mostrar.map((p) => {
        const itens = Array.isArray(p.itens) ? p.itens : [];
        return "<tr><td>" + esc(p.numero) + "</td><td>" + esc(dataHora(p.criado_em)) + "</td><td>" + (p.tipo === "local" ? "Mesa " + esc(p.mesa) : esc(ROTULO_TIPO[p.tipo] || p.tipo)) + "</td>" +
          "<td><details><summary>" + itens.length + (itens.length === 1 ? " item" : " itens") + "</summary>" +
            '<ul class="itens itens--mini">' + itens.map((i) => "<li>" + esc(i.qtd) + "× " + esc(i.nome) + (Array.isArray(i.opcoes) && i.opcoes.length ? "<small>" + esc(i.opcoes.join(" · ")) + "</small>" : "") + (i.obs ? "<em>📝 " + esc(i.obs) + "</em>" : "") + "</li>").join("") + "</ul></details></td>" +
          '<td class="r">' + brl(p.total) + "</td><td>" + (p.pago_em ? "✅ " + esc(p.pago_forma) : esc(p.forma_pagamento) + ' <span class="muted">· a receber</span>') + "</td>" +
          '<td><span class="status-tag status-tag--' + esc(p.status) + '">' + esc(ROTULO[p.status] || p.status) + "</span></td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function htmlHistorico() {
    const f = hs.f;
    return (
      '<div class="vhead"><h2>Histórico de pedidos</h2></div>' +
      '<form class="filtros" id="hsForm" novalidate>' +
        '<label>De<input type="date" id="hsDe" value="' + esc(hs.de) + '"></label>' +
        '<label>Até<input type="date" id="hsAte" value="' + esc(hs.ate) + '"></label>' +
        '<button type="submit" class="btn btn--primary" id="hsBuscar" data-act="hs-buscar">Buscar período</button>' +
        '<label>Mesa<input type="number" inputmode="numeric" min="1" max="999" id="hsMesa" value="' + esc(f.mesa) + '" placeholder="todas"></label>' +
        '<label>Valor mín. (R$)<input type="text" inputmode="decimal" id="hsMin" value="' + esc(f.min) + '" placeholder="0"></label>' +
        '<label>Valor máx. (R$)<input type="text" inputmode="decimal" id="hsMax" value="' + esc(f.max) + '" placeholder="sem limite"></label>' +
        '<label>Tipo<select id="hsTipo"><option value="">Todos</option><option value="local"' + (f.tipo === "local" ? " selected" : "") + '>No local</option><option value="entrega"' + (f.tipo === "entrega" ? " selected" : "") + '>Entrega</option><option value="retirada"' + (f.tipo === "retirada" ? " selected" : "") + ">Retirada</option></select></label>" +
        '<label>Situação<select id="hsPgto"><option value="">Todas</option><option value="pago"' + (f.pgto === "pago" ? " selected" : "") + '>Pagos</option><option value="receber"' + (f.pgto === "receber" ? " selected" : "") + '>A receber</option><option value="cancelado"' + (f.pgto === "cancelado" ? " selected" : "") + ">Cancelados</option></select></label>" +
        '<label class="filtros__busca">Buscar item ou observação<input type="search" id="hsBusca" value="' + esc(f.busca) + '" placeholder="ex.: kafta, heineken, ao ponto"></label>' +
        '<button type="button" class="btn btn--ghost" data-act="hs-csv" id="hsCsv">⬇ Exportar planilha (CSV)</button>' +
      "</form>" +
      '<div id="hsLista">' + htmlHistoricoLista() + "</div>"
    );
  }

  function renderHistoricoLista() { const el = $("#hsLista"); if (el) el.innerHTML = htmlHistoricoLista(); }

  async function carregarHistorico() {
    const de = $("#hsDe") ? $("#hsDe").value : hs.de;
    const ate = $("#hsAte") ? $("#hsAte").value : hs.ate;
    if (!ymdValido(de) || !ymdValido(ate) || de > ate) { toast("Confira as datas: \"De\" precisa ser antes de \"Até\".", 3500); return; }
    hs.de = de; hs.ate = ate;
    hs.carregando = true; hs.erro = ""; renderHistoricoLista();
    try {
      const dados = await buscarPeriodo(inicioDia(de), fimDia(ate));
      if (visao !== "historico") return;
      hs.dados = dados;
    } catch (e) { hs.erro = erroCarga(e); }
    hs.carregando = false;
    if (visao === "historico") renderHistoricoLista();
  }

  function abrirHistorico() {
    if (!hs.de) { const h = diaTrabalhoHoje(); hs.ate = h; hs.de = somaDias(h, -6); }
    $("#view").innerHTML = htmlHistorico();
    if (!hs.dados) carregarHistorico();
  }

  const csvCel = (v) => { v = String(v == null ? "" : v); return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csvNum = (n) => (n == null ? "" : Number(n).toFixed(2).replace(".", ","));

  function exportarCSV() {
    const lista = filtrarHistorico();
    if (!lista.length) { toast("Nada para exportar com esses filtros."); return; }
    const cab = ["Pedido", "Data e hora", "Tipo", "Mesa", "Itens", "Subtotal", "Taxa de entrega", "Total", "Pagamento (pedido)", "Status", "Pago em", "Recebido em (forma)", "Observação"];
    const linhas = lista.map((p) => [
      p.numero, dataHora(p.criado_em), ROTULO_TIPO[p.tipo] || p.tipo, p.mesa == null ? "" : p.mesa, resumoItens(p),
      csvNum(p.subtotal), csvNum(p.taxa_entrega), csvNum(p.total), p.forma_pagamento, ROTULO[p.status] || p.status,
      p.pago_em ? dataHora(p.pago_em) : "", p.pago_forma || "", p.observacao || ""
    ]);
    const texto = "﻿" + [cab].concat(linhas).map((l) => l.map(csvCel).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
    a.download = "pedidos_" + hs.de + "_a_" + hs.ate + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(lista.length + " pedido(s) exportados.");
  }

  /* ---------------------------------------------------------------------- */
  /* Navegação entre seções e redesenho                                     */
  /* ---------------------------------------------------------------------- */
  function refrescar() {
    const { ativos, finais } = contadores();
    if (visao === "pedidos") renderPedidos(ativos, finais);
    else if (visao === "mesas") renderMesas();
    else if (visao === "caixa" && cx.dados && !cx.carregando) renderCaixa();
    else if (visao === "historico") renderHistoricoLista();
  }

  function mudarVisao(v) {
    visao = v;
    $$(".nav__b").forEach((b) => b.classList.toggle("is-active", b.dataset.visao === v));
    $("#barPedidos").hidden = v !== "pedidos";
    $("#board").hidden = v !== "pedidos";
    $("#view").hidden = v === "pedidos";
    assinatura = "";
    if (v === "pedidos" || v === "mesas") refrescar();
    else if (v === "caixa") abrirCaixa();
    else if (v === "ranking") abrirRanking();
    else abrirHistorico();
  }

  function aplicar(lista) {
    const mapa = new Map();
    const chegaram = [];
    lista.forEach((p) => {
      mapa.set(p.id, p);
      if (!primeiraCarga && !pedidos.has(p.id) && p.status === "novo") chegaram.push(p);
    });
    pedidos = mapa;
    primeiraCarga = false;
    if (chegaram.length) {
      chegaram.forEach((p) => {
        piscando.add(p.id);
        setTimeout(() => { piscando.delete(p.id); assinatura = ""; }, 9000);
      });
      bip();
      toast(chegaram.length === 1 ? "Novo pedido!" : chegaram.length + " novos pedidos!");
      if (autoImp) chegaram.slice().sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em)).forEach(enfileirarImpressao);
    }
    // só redesenha quando algo mudou (evita "piscar" a tela a cada busca)
    const sig = lista.map((p) => p.id + ":" + p.status + ":" + (p.pago_em ? 1 : 0)).join("|") + "#" + visao + aba + filtro + "#" + piscando.size;
    if (sig !== assinatura) { assinatura = sig; refrescar(); }
    else contadores();
  }

  function atualizarTempos() {
    $$(".tempo[data-ts]").forEach((el) => { el.textContent = hora(el.dataset.ts) + " · " + textoTempo(el.dataset.ts); });
    $$(".pedido").forEach((el) => {
      const p = pedidos.get(el.dataset.id);
      if (!p) return;
      el.classList.toggle("pedido--atraso", (p.status === "novo" || p.status === "preparo") && minutos(p.criado_em) >= ALERTA_MIN);
    });
    if (visao === "mesas") renderMesas();   // "aberta há X"
  }

  /* ---------------------------------------------------------------------- */
  /* Ações                                                                  */
  /* ---------------------------------------------------------------------- */
  async function mudarStatus(id, novo) {
    const p = pedidos.get(id);
    if (!p) return;
    const anterior = p.status;
    p.status = novo;           // atualiza na hora; volta atrás se falhar
    assinatura = "";
    refrescar();
    try {
      const r = await autenticado("/rest/v1/pedidos?id=eq." + encodeURIComponent(id), { method: "PATCH", body: { status: novo }, headers: { Prefer: "return=representation" } });
      if (!r.ok) throw new Error("http " + r.status);
      const linhas = await r.json();
      if (Array.isArray(linhas) && linhas.length === 0) throw new Error("sem permissão");
    } catch (e) {
      p.status = anterior;
      assinatura = "";
      refrescar();
      if (e && e.message === "sessao") return sair("Sessão expirada. Entre novamente.");
      toast("Não foi possível atualizar o pedido. Tente de novo.");
    }
  }

  // ações dos botões (cartões, mesas, caixa, histórico)
  function aoClicar(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const p = b.dataset.id ? (pedidos.get(b.dataset.id) || (cx.dados || []).find((x) => x.id === b.dataset.id) || (hs.dados || []).find((x) => x.id === b.dataset.id)) : null;
    if (p) piscando.delete(p.id);

    if (act === "avancar" && p && AVANCAR[p.status]) mudarStatus(p.id, AVANCAR[p.status][0]);
    else if (act === "reabrir" && p) mudarStatus(p.id, "preparo");
    else if (act === "cancelar" && p) { if (window.confirm("Cancelar o pedido #" + p.numero + "?")) mudarStatus(p.id, "cancelado"); }
    else if (act === "imprimir" && p) imprimir(p);
    else if ((act === "receber" || act === "cx-receber") && p) {
      abrirPagamento([p], "Receber pedido #" + p.numero, (p.tipo === "local" ? "Mesa " + p.mesa : ROTULO_TIPO[p.tipo]) + " · pedido do cliente: " + p.forma_pagamento);
    }
    else if (act === "desfazer-pgto" && p) {
      if (window.confirm("Desfazer o pagamento do pedido #" + p.numero + "? Ele volta para \"a receber\".")) salvarPagamento([p.id], null, null).then((ok) => { if (ok) toast("Pagamento desfeito."); });
    }
    else if (act === "fechar-mesa" || act === "imprimir-conta") {
      const entrada = mesasAbertas().find((m) => String(m[0]) === String(b.dataset.mesa));
      if (!entrada) return;
      if (act === "imprimir-conta") imprimirConta(entrada[0], entrada[1]);
      else abrirPagamento(entrada[1], "Fechar conta · Mesa " + entrada[0], "Soma de " + entrada[1].length + (entrada[1].length === 1 ? " pedido" : " pedidos"));
    }
    else if (act === "cx-ant" || act === "cx-prox") { cx.dia = somaDias(cx.dia, act === "cx-ant" ? -1 : 1); carregarCaixa(); }
    else if (act === "cx-hoje") { cx.dia = diaTrabalhoHoje(); carregarCaixa(); }
    else if (act === "cx-atualizar") carregarCaixa();
    else if (act === "cx-imprimir") imprimirCaixa();
    else if (act === "rk-atualizar") carregarRanking();
    else if (act === "hs-buscar") { e.preventDefault(); carregarHistorico(); }
    else if (act === "hs-csv") exportarCSV();
  }

  function aoMudarView(e) {
    const t = e.target;
    if (t.id === "cxDia") { if (ymdValido(t.value)) { cx.dia = t.value; carregarCaixa(); } }
    else if (t.id === "rkDias") { rk.dias = Number(t.value) || 7; carregarRanking(); }
    else if (t.id === "rkOrd") { rk.ord = t.value === "total" ? "total" : "qtd"; renderRanking(); }
    else if (t.id === "hsMesa") { hs.f.mesa = t.value; renderHistoricoLista(); }
    else if (t.id === "hsMin") { hs.f.min = t.value; renderHistoricoLista(); }
    else if (t.id === "hsMax") { hs.f.max = t.value; renderHistoricoLista(); }
    else if (t.id === "hsTipo") { hs.f.tipo = t.value; renderHistoricoLista(); }
    else if (t.id === "hsPgto") { hs.f.pgto = t.value; renderHistoricoLista(); }
    else if (t.id === "hsBusca") { hs.f.busca = t.value; renderHistoricoLista(); }
  }

  /* ---------------------------------------------------------------------- */
  /* Ciclo de atualização                                                   */
  /* ---------------------------------------------------------------------- */
  function conexao(ok) {
    const c = $("#conn");
    c.className = "conn " + (ok ? "ok" : "off");
    c.textContent = ok ? "Conectado · atualiza a cada " + INTERVALO / 1000 + " s" : "Sem conexão · tentando de novo…";
  }

  async function ciclo() {
    clearTimeout(timer);
    try {
      aplicar(await buscar());
      conexao(true);
    } catch (e) {
      if (e && e.message === "sessao") return sair("Sessão expirada. Entre novamente.");
      conexao(false);
    }
    timer = setTimeout(ciclo, INTERVALO);
  }

  function mostrarApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#titulo").textContent = PAINEL.nome || "Painel de pedidos";
    atualizarBotaoSom();
    atualizarBotaoImp();
    primeiraCarga = true;
    ciclo();
  }

  function sair(msg) {
    clearTimeout(timer);
    sessao = null;
    apagarLS(LS_SESSAO);
    pedidos = new Map();
    assinatura = "";
    cx.dados = null; rk.dados = null; hs.dados = null;
    filaImp.length = 0;
    fecharModal();
    visao = "pedidos";
    $$(".nav__b").forEach((b) => b.classList.toggle("is-active", b.dataset.visao === "pedidos"));
    $("#barPedidos").hidden = false; $("#board").hidden = false; $("#view").hidden = true;
    $("#app").hidden = true;
    $("#login").hidden = false;
    document.title = "Painel · " + (PAINEL.nome || "Pedidos");
    const err = $("#lErro");
    err.hidden = !msg;
    err.textContent = msg || "";
  }

  /* ---------------------------------------------------------------------- */
  /* Eventos e início                                                       */
  /* ---------------------------------------------------------------------- */
  async function entrar(e) {
    e.preventDefault();
    const err = $("#lErro");
    err.hidden = true;
    destravarAudio();   // o clique no botão libera o som no navegador
    const email = $("#lEmail").value.trim();
    const senha = $("#lSenha").value;
    if (!email || !senha) { err.textContent = "Informe e-mail e senha."; err.hidden = false; return; }
    const btn = $("#lBtn");
    btn.disabled = true;
    btn.textContent = "Entrando…";
    try {
      const r = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password: senha } });
      if (r.status === 400 || r.status === 401 || r.status === 422) throw new Error("credenciais");
      if (!r.ok) throw new Error("http " + r.status);
      guardarSessao(await r.json());
      $("#lSenha").value = "";
      mostrarApp();
    } catch (ex) {
      err.textContent = ex.message === "credenciais" ? "E-mail ou senha incorretos." : "Não foi possível conectar ao servidor. Confira a internet e a configuração.";
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Entrar";
    }
  }

  function iniciar() {
    $("#loginTitulo").textContent = PAINEL.nome || "Painel de pedidos";
    document.title = "Painel · " + (PAINEL.nome || "Pedidos");

    $("#loginForm").addEventListener("submit", entrar);
    $("#btnSair").addEventListener("click", () => sair(""));
    $("#btnSom").addEventListener("click", () => {
      if (somLigado && !audioPronto()) { destravarAudio(); setTimeout(() => { bip(); atualizarBotaoSom(); }, 150); return; }
      somLigado = !somLigado;
      gravarLS(LS_SOM, somLigado ? "on" : "off");
      if (somLigado) { destravarAudio(); setTimeout(bip, 150); }
      atualizarBotaoSom();
    });
    $("#btnImp").addEventListener("click", () => {
      autoImp = !autoImp;
      gravarLS(LS_IMP, autoImp ? "on" : "off");
      atualizarBotaoImp();
      toast(autoImp ? "Cada pedido novo será impresso. Para não abrir a janela de impressão, veja o README (modo quiosque)." : "Impressão automática desligada.", autoImp ? 5000 : 2600);
    });
    document.addEventListener("pointerdown", () => { destravarAudio(); setTimeout(atualizarBotaoSom, 200); }, { once: true });

    $("#nav").addEventListener("click", (e) => { const b = e.target.closest("[data-visao]"); if (b) mudarVisao(b.dataset.visao); });

    $$(".tab").forEach((b) => b.addEventListener("click", () => {
      aba = b.dataset.aba;
      $$(".tab").forEach((x) => x.classList.toggle("is-active", x === b));
      assinatura = "";
      refrescar();
    }));
    $("#chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filtro]");
      if (!b) return;
      filtro = b.dataset.filtro;
      $$(".chip").forEach((x) => x.classList.toggle("is-active", x === b));
      assinatura = "";
      refrescar();
    });

    $("#board").addEventListener("click", aoClicar);
    $("#view").addEventListener("click", aoClicar);
    $("#view").addEventListener("change", aoMudarView);
    $("#view").addEventListener("input", (e) => { if (["hsMesa", "hsMin", "hsMax", "hsBusca"].indexOf(e.target.id) >= 0) aoMudarView(e); });
    $("#view").addEventListener("submit", (e) => { e.preventDefault(); if (e.target.id === "hsForm") carregarHistorico(); });

    // janela de pagamento
    $("#mFormas").addEventListener("click", (e) => {
      const b = e.target.closest("[data-forma]");
      if (!b || !pag) return;
      pag.forma = b.dataset.forma;
      $$(".forma").forEach((x) => { const on = x === b; x.classList.toggle("is-on", on); x.setAttribute("aria-pressed", on); });
      $("#mOk").disabled = false;
    });
    $("#mOk").addEventListener("click", confirmarPagamento);
    $("#mCancel").addEventListener("click", fecharModal);
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") fecharModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) fecharModal(); });

    setInterval(atualizarTempos, 30000);

    if (!BASE || !KEY) {
      $("#login").hidden = false;
      const err = $("#lErro");
      err.textContent = "Painel sem configuração: preencha supabaseUrl e anonKey em painel/config.js.";
      err.hidden = false;
      $("#lBtn").disabled = true;
      return;
    }
    if (sessao) mostrarApp();
    else $("#login").hidden = false;
  }

  iniciar();
})();
