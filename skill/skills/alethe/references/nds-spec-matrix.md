# Matriz de Avaliação de Specs (Revisor / Claude 4.5 Opus)

Para impedir a geração de documentações genéricas que existem apenas para "cumprir tabela", a validação da Spec deve contrastar rigorosamente os seguintes critérios em cada categoria:

| Categoria Obrigatória | Conteúdo Válido & Relevante (Aprovado) | Sinal de "Cumprir Tabela" (Reprovado) |
| :--- | :--- | :--- |
| **1. Contexto & Propósito** *(Why & Where)* | Explica o problema real de negócio, motivação técnica, serviços/arquivos afetados e valor gerado. | Frases genéricas como "Melhorar o sistema", "Criar nova tela" ou descrições abstratas sem vínculo técnico. |
| **2. Requisitos Funcionais & Comportamento** *(What)* | Define detalhadamente regras de negócio, contratos de dados, payload de entrada/saída e fluxos de estado. | Frases óbvias/superficiais como "O sistema deve salvar os dados" ou "Deve funcionar corretamente". |
| **3. Restrições Técnicas & Arquiteturais** *(How)* | Detalha integrações, esquemas de BD, rotas de API, limites de performance e padrões a aplicar. | "Seguir boas práticas" ou "Usar código limpo" sem declarar tecnologias, rotas ou estruturas reais. |
| **4. Tratamento de Erros & Casos de Borda** *(Edge Cases)* | Mapeia cenários como falha de rede, timeouts, concorrência, payloads inválidos, retornos HTTP/exceções. | Frases vagas como "Tratar erros graciosamente" ou "Lançar exceção se der errado". |
| **5. Critérios de Validação & Testes** *(Definition of Done)* | Especifica cenários exatos de teste unitário/integração, coberturas esperadas e critérios claros de aceite. | "Testar a funcionalidade para garantir funcionamento". |

## Regras de uso (NDS fork)

- O validador roda em read-only e só responde: APROVADO nas 5, ou a lista de falhas por categoria.
- Falhas => o lead roda `orchestrate.py spec rejected --in current --text "<falhas>"` e volta ao planner.
- Aprovação => `orchestrate.py spec approved --in current` e segue para o GATE HUMANO.
- Máximo 2 reprovações; a 3ª aborta o fluxo automaticamente.
