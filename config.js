/* ==========================================================================
   CONFIGURAÇÃO DO PAINEL DE PEDIDOS
   Use a MESMA url e anonKey que estão em js/config.js do cardápio.
   Use a chave PÚBLICA (anon). Nunca coloque a service_role aqui.
   ========================================================================== */
const PAINEL = {
  nome: "Espeto da Praça",
  supabaseUrl: "https://xqqpfledrtriqidjbvdh.supabase.co",          // ex.: "https://abcdefgh.supabase.co"
  anonKey: "sb_publishable_NtD1RTuPASEhqlL7IkOWTg_wbf0wiZr",              // ex.: "eyJhbGciOi..."
  intervaloSegundos: 5,     // de quanto em quanto tempo o painel busca pedidos novos
  alertaMinutos: 15,        // pedido novo/em preparo há mais que isso fica destacado em vermelho
  formasPagamento: ["Pix", "Dinheiro", "Cartão de crédito", "Cartão de débito"],   // opções ao fechar a conta
  viradaDiaHora: 5          // o "dia de trabalho" (Caixa, relatórios) vira às 5h: vendas até 5h da manhã contam no dia anterior
};
