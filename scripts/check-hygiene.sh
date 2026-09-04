#!/usr/bin/env bash
# check-hygiene.sh — 工程卫生检查（CI hygiene job / 本地随时可跑）
# 设计依据与每条规则的理由见 docs/deploy/03-review-and-branching.md 第 2 节。
# 无外部依赖，只用 bash + grep，与项目「零依赖」气质一致。
# 用法：bash scripts/check-hygiene.sh      （在仓库根目录执行）
set -uo pipefail

FAIL=0
note() { printf '  %s\n' "$1"; }
ok()   { printf '[ OK ] %s\n' "$1"; }
bad()  { printf '[FAIL] %s\n' "$1"; FAIL=1; }

cd "$(dirname "$0")/.."

# ---------- 1. index.html 每个 script 都带 ?v= 版本号 ----------
# 依据：README v2.8.1——不带版本号会加载浏览器旧缓存，「改动后看不到新内容」（踩过的坑）
MISSING_V=$(grep -o 'src="[^"]*\.js[^"]*"' index.html | grep -v '?v=' || true)
if [ -z "$MISSING_V" ]; then
  ok "index.html 所有 script 均带 ?v= 版本号"
else
  bad "index.html 有 script 缺少 ?v= 版本号："
  printf '%s\n' "$MISSING_V" | sed 's/^/       /'
fi

# ---------- 2. 所有 ?v= 值一致 ----------
# 依据：版本号不统一 = 部分文件走缓存部分不走，最难查的一类 bug
# 注意：只从 src="..." 属性内提取，避免把 HTML 注释里的说明文字当成版本号（实测踩过）
VERSIONS=$(grep -o 'src="[^"]*\.js?v=[^"]*"' index.html | sed 's/.*?v=//; s/"$//' | sort -u)
VER_COUNT=$(printf '%s\n' "$VERSIONS" | grep -c . || true)
if [ "$VER_COUNT" -le 1 ]; then
  ok "index.html 版本号统一（v=$(printf '%s' "$VERSIONS" | tr -d '\n')）"
else
  bad "index.html 存在多个不同版本号，必须统一："
  printf '%s\n' "$VERSIONS" | sed 's/^/       /'
fi

# ---------- 3. js/ 下每个 .js 都被 index.html 或 test/ 引用 ----------
# 依据：防止新增模块忘记挂进依赖链
# 白名单：测试/联机 headless 专用模块，不进 index.html 属正常
WHITELIST="js/net/localTransport.js js/net/headlessGame.js"
UNREF=""
# 先把 index.html 与 test/ 的全部内容各读一次，再做纯字符串匹配。
# **不要在循环里 grep** —— 原实现对每个 js 文件都递归扫一遍 test/，
# 28 个文件 × 递归 grep 在 Windows 上要 2~3 分钟（进程创建开销，sys 时间占九成）。
# 一次性读取后整体耗时回到数秒。
INDEX_TXT=$(cat index.html 2>/dev/null || true)
TEST_TXT=$(cat $(find test -name '*.js' 2>/dev/null) 2>/dev/null || true)
for f in $(find js -name '*.js' | sed 's|\\|/|g' | sort); do
  case " $WHITELIST " in *" $f "*) continue ;; esac
  base=$(basename "$f")
  case "$INDEX_TXT" in *"$base"*) continue ;; esac
  case "$TEST_TXT" in *"$base"*) continue ;; esac
  UNREF="$UNREF $f"
done
if [ -z "$UNREF" ]; then
  ok "js/ 下所有模块均被 index.html 或 test/ 引用"
else
  bad "以下模块没有被 index.html 或 test/ 引用（漏挂依赖链？）："
  for f in $UNREF; do note "     $f"; done
fi

# ---------- 4. 逻辑模块不依赖 DOM ----------
# 依据：README 承诺「逻辑模块不依赖 DOM，可在 node 中直接加载」——
#       这是 smoke 测试与联机 headless 回放成立的前提，破了它测试直接跑不起来
LOGIC="config utils storage levels walls snake spawner particles ai multiplayer"
DOM_HIT=""
for m in $LOGIC; do
  f="js/$m.js"
  [ -f "$f" ] || continue
  if grep -nE '(^|[^a-zA-Z.])document\.|window\.addEventListener|getElementById|createElement' "$f" > /dev/null 2>&1; then
    DOM_HIT="$DOM_HIT $f"
  fi
done
if [ -z "$DOM_HIT" ]; then
  ok "逻辑模块无 DOM 依赖（node 可直接加载）"
else
  bad "以下逻辑模块出现 DOM 访问，会破坏 node 侧测试："
  for f in $DOM_HIT; do
    note "     $f"
    grep -nE '(^|[^a-zA-Z.])document\.|window\.addEventListener|getElementById|createElement' "$f" | head -3 | sed 's/^/         /'
  done
fi

# ---------- 5. 代码里不硬编码服务器地址（IP 或域名）----------
# 依据：服务器地址只应出现在 workflow 与文档；代码硬编码会让本地/测试/正式串台。
# 域名同理——前端 ws 地址必须走 wsTransport.js 的 location.host 自适应逻辑，
# 一旦写死 snake.pippocao.top，本地开发和测试环境就都连到正式服了。
# 例外：test/wss-verify.js 是手动排障工具，域名只出现在注释的示例用法里，URL 由 argv 传入。
#
# **必须排除 node_modules**：v3.1 阶段 1d 起 server/ 带了 75 个依赖包
# （WebTransport 的 native addon 及其依赖树）。不排除会让本检查从数秒变成
# 3 分钟（实测），CI 也跟着慢；而依赖里的地址本来就不是我们的代码。
NOMOD='--exclude-dir=node_modules'
ADDR_HIT=$(grep -rnE $NOMOD '43\.161\.196\.218|[a-z-]*\.?pippocao\.top' js/ server/ test/ 2>/dev/null \
  | grep -v '^test/wss-verify\.js:.*//' || true)
if [ -z "$ADDR_HIT" ]; then
  ok "js/ server/ test/ 无硬编码服务器地址（IP / 域名）"
else
  bad "代码中出现硬编码服务器地址（应只存在于 workflow 与文档）："
  printf '%s\n' "$ADDR_HIT" | sed 's/^/       /'
fi

# ---------- 6. 不出现疑似密钥/密码字面量 ----------
# 依据：本方案全程零长期密钥，任何密钥字面量入仓都是事故
# 说明：仅扫描代码与配置目录，不扫描本文件自身与文档；同样排除 node_modules
# （依赖包里带测试用私钥是常态，不是我们的事故）
SECRET_HIT=$(grep -rnE $NOMOD -- '-----BEGIN [A-Z ]*PRIVATE KEY|SecretKey["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9]{8,}' \
  js/ server/ test/ scripts/ .github/ 2>/dev/null | grep -v 'check-hygiene.sh' || true)
if [ -z "$SECRET_HIT" ]; then
  ok "未发现疑似密钥/私钥字面量"
else
  bad "发现疑似密钥字面量，禁止入仓："
  printf '%s\n' "$SECRET_HIT" | sed 's/^/       /'
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "==== hygiene: 全部通过 ===="
else
  echo "==== hygiene: 存在失败项，见上方 [FAIL] ===="
fi
exit "$FAIL"
