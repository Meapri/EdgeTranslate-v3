# EdgeTranslate legacy manual release checklist

> 이 문서는 이전 프로젝트의 수동 기능 점검표라서 현재 AI 페이지 번역, 실시간 자막,
> PDF, Safari 경로를 모두 다루지 않는다. 현재 릴리스 절차는
> [개발 가이드](./docs/DEVELOPMENT_GUIDE.md#20-%EB%A6%B4%EB%A6%AC%EC%8A%A4)를 먼저 따르고,
> 이 목록은 추가 UI 점검표로만 사용한다.

## 功能测试

### 核心功能

-   [x] 划词弹出翻译按钮，划词立即翻译，翻译完成后取消文本选择

-   [x] 双击弹出翻译按钮，双击立即翻译

-   [ ] 侧边栏发音按钮测试，原始文本编辑/重新翻译（火狐上无效），翻译结果复制按钮

-   [ ] source、target 发音，详细意思，定义和例句过长内容的展开/折叠

-   [x] 侧边栏到设置页面的跳转

-   [ ] 关闭侧边栏自动停止发音

-   [ ] popup 输入框查词，互译模式，语言设定

-   [ ] pdf 文件权限请求，自动跳转，划词翻译

-   [ ] 提示页面自动跳转，翻译结果展示

-   [ ] 各翻译接口功能测试

-   [ ] 混合翻译功能测试

-   [ ] 语言设定与默认翻译源设定的联动

-   [ ] 错误信息展示

-   [ ] PDF 阅读器与 chrome 自带阅读器的切换，黑色阅读模式

### UI

-   [x] 弹出侧边栏时压缩/不压缩页面

-   [x] 侧边栏固定/取消固定/自动隐藏

-   [ ] 侧边栏固定模式/悬浮模式切换

-   [ ] 侧边栏拖动/自动贴边/大小调整

-   [ ] 翻译按钮随页面滚动

-   [ ] 发音失败后顶部弹出错误提示框

-   [x] 从右到左显示内容

-   [ ] 翻译按钮出现在鼠标的`左上/右上/左下/右下`位置

### 网页翻译

-   [ ] 各翻译器功能测试

-   [ ] 默认翻译器设置

-   [x] cloud AI `auto`/default가 vNext, 명시적 `stable`이 rollback으로 라우팅되는지 확인

-   [x] `chromeBuiltin`은 기존 V1, `GooglePageTranslate`는 별도 injection 경로인지 확인

-   [x] `npm run gate:ai-page:vnext:offline` 통과

-   [x] `npm run build:chrome` 뒤 default-vNext와 explicit-stable Chrome smoke 모두 통과

-   [x] 京阪本線 exact OpenAI/Gemini-shaped local stub: 각각 baseline 27 requests,
        2,004/2,004 targets, failed/recovery 0, anchor 100, runtime exception 0

-   [x] 京阪本線의 30 requests는 fixture regression ceiling이며 arbitrary page global
        guarantee가 아님을 문서화

-   [x] same-packet backoff failure는 실제 provider를 재호출하고,
        success/delivery-unknown/recovery-class만 idempotency cache replay하는지 확인

-   [x] startup hydration root buffer, active-provider cancel terminal, CAS 포함
        viewport/reveal priority 없음, unsafe inline chunk atomic degrade 회귀 테스트

-   [x] normalized UsageReceipt `{value,source}` EMA와 warm modern 8K fallback floor 보존 확인

-   [x] provider input/combined context 90% 안전선과 pre-dispatch rejection, production
        5,282-inline `<=30` balanced-request 회귀 테스트

-   [x] 병렬 first-wave 429/5xx는 조기 circuit을 열지 않고, retry-exhausted lineage만
        no-output circuit에 집계되는지 확인

-   [x] 429/5xx/timeout/provider-status가 교대로 발생해도 한 lineage의 transport retry
        budget이 3회를 넘지 않는지 확인

-   [x] `pt3-2` exact item-count/alias schema, protected-value prompt, interactive order retry와
        atomic fallback, 19,500자 recovery rechunk 회귀 테스트

-   [x] receipt EMA 이후 recovery fragment 증폭 제한, existing chunk의 nested-rechunk 차단,
        불가능한 singleton local terminalize 확인

-   [x] SPA revision 교체 뒤 이전 success/failure/chunk reply가 새 source recovery 또는
        새 chunk group을 오염시키지 않는지 확인

-   [x] failed string이 새 SPA revision에서 성공하면 incomplete 수치도 감소하고, 무공백
        CJK prose source echo는 성공으로 오인하지 않는지 확인

-   [x] 실패 진단이 `failedStrings`/`failedRepresentatives`/`failedByReason`을 분리하는지 확인

-   [ ] OpenAI/Gemini live Gate C 품질 A/B

-   [ ] live Gate D latency와 full drain

-   [ ] 같은 provider/snapshot의 stable 대비 Gate E 실제 usage receipts

-   [ ] Gate F 30분 human spot-check

-   [x] provider-reported usage와 배너 total 일치; content-channel owner response loss는
        estimated request 1회로 세고, 배너는 exact integer 및 추정 시 `~` 표시

-   [ ] API key는 fresh local environment에만 두고 대화/repo/log/artifact에는 남기지 않기

-   [ ] Gates C-F와 production soak 전 stable/V1/호환 runtime 삭제하지 않기

### 黑名单功能

-   [ ] 网址加入/移出黑名单

-   [ ] 域名加入/移出黑名单

### 快捷键

-   [ ] 激活 popup

-   [ ] 启用/禁用互译模式

-   [ ] 展开翻译语言设定

-   [ ] 交换源语言/目标语言

-   [ ] 翻译选中单词

-   [ ] 朗读原始文本

-   [ ] 朗读翻译结果

-   [ ] 复制翻译结果

-   [ ] 固定侧边栏

-   [ ] 关闭侧边栏

-   [ ] 朗读选中单词

-   [ ] 翻译当前页面

-   [ ] 取消页面翻译

-   [ ] 打开/关闭网页翻译(谷歌)的顶部栏

-   [ ] 与`Vimium C - All by Keyboard`插件在 PDF 阅读器中能够共同运行

## 版本信息

-   manifest.json，package.json，package-lock.json

-   git tag

-   更新日志
