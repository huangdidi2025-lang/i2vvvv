# i2v_extension/lib/

从 background.js / content.js 抽出的纯辅助函数，作为 ES module。

**重要：** 这些是副本，不是生产代码的权威源。权威实现仍在原文件里。
这里存在只为了让同样的逻辑能用 `node --test` 在 Chrome 之外做单测。

更新时：原文件和 lib 副本**同时**改，并跑测试。
