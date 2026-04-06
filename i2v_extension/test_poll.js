/**
 * 延伸状态轮询测试脚本
 *
 * 使用方式：
 * 1. 打开 Google Flow 项目页面
 * 2. F12 打开控制台
 * 3. 粘贴此脚本运行
 *
 * 功能：每 10 秒扫描一次项目页所有视频卡的延伸状态
 * 判断依据：<i> 图标 — videocam = 视频卡，stacks = 已延伸
 */

(function testPoll() {
  const LOG = '[轮询测试]';
  let round = 0;

  function scan() {
    round++;
    const tiles = document.querySelectorAll('a[href*="/edit/"]');
    const videos = [];
    const seen = new Set();

    tiles.forEach(tile => {
      const uuid = tile.getAttribute('href')?.match(/\/edit\/([a-f0-9-]+)/)?.[1];
      if (!uuid || seen.has(uuid)) return;
      seen.add(uuid);

      const parent = tile.closest('button') || tile.parentElement;
      const icons = parent ? Array.from(parent.querySelectorAll('i')).map(el => el.textContent.trim()) : [];
      const isVideo = icons.includes('videocam');
      if (!isVideo) return;

      const isExtended = icons.includes('stacks');
      videos.push({ uuid: uuid.substring(0, 8), isExtended, icons });
    });

    const extended = videos.filter(v => v.isExtended);
    const needExtend = videos.filter(v => !v.isExtended);

    console.log(`${LOG} === 第 ${round} 轮 ===`);
    console.log(`${LOG} 视频总数: ${videos.length} | 已延伸: ${extended.length} | 未延伸: ${needExtend.length}`);

    if (extended.length > 0) {
      console.log(`${LOG} ✓ 已延伸:`, extended.map(v => v.uuid).join(', '));
    }
    if (needExtend.length > 0) {
      console.log(`${LOG} ✗ 需延伸:`, needExtend.map(v => v.uuid).join(', '));
    }
    if (needExtend.length === 0 && videos.length > 0) {
      console.log(`${LOG} ✅ 全部延伸完成！停止轮询`);
      clearInterval(timer);
      return;
    }

    // 详细列出每个视频的图标
    console.table(videos.map(v => ({
      UUID: v.uuid,
      状态: v.isExtended ? '✓ 已延伸' : '✗ 未延伸',
      图标: v.icons.join(', '),
    })));
  }

  // 立即执行一次
  scan();
  // 每 10 秒轮询
  const timer = setInterval(scan, 10000);

  // 提供停止方法
  window.__stopPoll = () => { clearInterval(timer); console.log(`${LOG} 已手动停止`); };
  console.log(`${LOG} 轮询已启动，每 10 秒检查一次。输入 __stopPoll() 停止`);
})();
