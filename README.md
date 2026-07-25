# Steam 库存一键出售 v1.1.0

> 当前 `v1.1.0` 仅作为仓库测试版本，不创建 Git 标签或 GitHub Release。

这是一个仅在本机运行的 Windows 原生桌面工具。它直接复用正在运行的桌面 Steam
客户端登录状态，不提供也不需要独立登录功能。工具会按用户输入的名称扫描全部
Steam 库存，并以自定义价格或实时市场价格批量提交社区市场出售请求。

桌面界面分为两个独立模块：

- 模块一：按普通物品名称扫描，可使用自定义买家支付价或卖家实收金额，也可选择
  “以市场底价出售”或“以最高求购价出售”。
- 模块二：扫描全部可出售的 Steam 集换式卡牌，可以按各自市场最低在售价挂单，
  也可以按各自当前最高求购价优先立即成交。

## 使用

1. 双击 `start.bat`。程序会自动在当前用户桌面创建或修复
   `efficent_sell` 快捷方式，无需管理员权限。
2. 第一次运行会安装一个小型浏览器控制组件。
3. 保持桌面 Steam 已登录，并在 Steam 客户端中打开一次“社区市场”或“库存”页面。
4. 输入完整物品名，先扫描并核对匹配数量。
5. 可以输入每件价格并选择“买家支付总价”或“卖家实收金额”，也可在模块一选择
   “以市场底价出售”或“以最高求购价出售”，核对自动取得的价格后出售。
   如需出售集换式卡牌，可在模块二选择“按市场最低在售价扫描”或
   “按最高求购价扫描（优先立即成交）”，核对每种卡牌的价格后勾选确认并出售，
   无需手动输入价格。
6. 如果 Steam 要求额外确认，请在 Steam 手机应用或邮箱中完成确认。
7. 上架任务结束后，工具会重新扫描同名物品，强制刷新一键上架界面并更新剩余库存。

程序只连接 Steam 在本机 `127.0.0.1` 上开放的客户端调试接口，会话仍由 Steam
客户端自己管理。后台运行日志保存在 `.data/backend.log`。程序不会读取或保存
Steam 密码，也不需要 API Key、共享密钥或身份密钥。

## 自动更新

程序启动后会在后台检查
[`kristong769-maker/efficient_sell`](https://github.com/kristong769-maker/efficient_sell/releases)
的最新正式 Release。发现更高版本时，页面顶部会显示“下载并安装”：

1. 更新包及 SHA-256 校验文件从指定 GitHub 仓库下载。
2. 下载完成后校验压缩包 SHA-256，并验证包内清单和每个文件的哈希值。
3. 主程序退出后，独立更新器备份旧文件并安装新版本。
4. `.data`、`node_modules` 和 Steam 登录状态不会被覆盖。
5. 安装失败时会尝试恢复备份，重新启动后显示失败原因。

`v1.0.2` 及更早版本没有自动更新器，因此现有用户需要手动安装一次 `v1.0.3`；
从 `v1.0.3` 开始，后续正式版本可以在程序内一键更新。

## 安全设计

- 上架前必须先预览匹配结果，并再次勾选确认。
- 自动取得的市场底价在提交前最多保留 60 秒，超时后必须重新扫描，避免使用陈旧价格。
- 最高求购价最多保留 30 秒，并按最高价档位的求购数量限制可出售数量。市场价格
  仍可能在提交瞬间变化；若最高求购单已被其他人买走，Steam 可能创建同价挂单，
  最终成交结果以 Steam 市场记录为准。
- 默认使用精确名称匹配，避免相似名称误售。
- 所有接口只监听 `127.0.0.1`，写操作还会检查本地来源与随机会话令牌。
- 最多一次处理 500 件，逐件限速提交，并对 Steam 429 限流自动退避。
- 默认使用 2 路错峰上架；临时错误自动重试，累计出现两次后自动切换为单线程。
- 不会自动处理手机确认，因此不要求提供 Steam Guard 身份密钥。

## 开发

需要 Node.js 20 或更高版本：

```powershell
npm.cmd install
npm.cmd test
python -m unittest discover -s test -p "test_*.py"
npm.cmd start
```

如 Edge 不在默认路径，可设置 `EDGE_PATH` 环境变量指向 Edge 或 Chrome。

## 发布新版本

发布前需要把 `package.json`、`package-lock.json`、`native-ui.py` 和本文件中的
版本号改为同一个 `x.y.z`。然后运行测试并生成一次本地发布包：

```powershell
npm.cmd test
python -m unittest discover -s test -p "test_*.py"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
```

确认无误后提交并推送同版本标签，例如：

```powershell
git add .
git commit -m "release: v1.1.1"
git tag -a v1.1.1 -m "Steam 库存一键出售 v1.1.1"
git push origin master
git push origin v1.1.1
```

`.github/workflows/release.yml` 会在标签推送后自动运行测试，生成
`efficent_sell-v1.1.1.zip` 和对应的 `.sha256`，并创建 GitHub Release。程序只把
包含可校验更新包的正式 Release 识别为可一键安装版本。
