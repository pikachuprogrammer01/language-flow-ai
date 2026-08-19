/**
 * 音频试听控制 — 音色合成试听与 BGM 本地试听共用（模块级单例）
 * 同一时刻只允许一个源播放（互斥）：play(key, src) 先停旧源；
 * toggle(key, src) 对同一 key 做播放/暂停切换；isPlaying(key) 判断指定源是否播放中。
 */
import { ref } from "vue";

export type PreviewKey = "voice" | "bgm";

/** 模块级状态：所有调用方共享同一个实例，天然互斥 */
let audio: HTMLAudioElement | null = null;
const playing = ref(false);
const currentKey = ref<PreviewKey | null>(null);

/** 停止当前播放（暂停并释放） */
function stop(): void {
  if (audio) {
    audio.pause();
    audio = null;
  }
  playing.value = false;
  currentKey.value = null;
}

/** 播放音频（先停旧源，避免叠加干扰） */
function play(key: PreviewKey, src: string): void {
  stop();
  const el = new Audio(src);
  audio = el;
  currentKey.value = key;
  playing.value = true;
  const release = (): void => {
    if (audio === el) {
      audio = null;
      playing.value = false;
      currentKey.value = null;
    }
  };
  el.onended = release;
  el.onerror = release;
  void el.play().catch(release);
}

/** 播放/暂停切换（同源播放中 → 暂停并同步状态；否则播放） */
function toggle(key: PreviewKey, src: string): void {
  if (playing.value && currentKey.value === key && audio) {
    audio.pause();
    playing.value = false;
  } else {
    play(key, src);
  }
}

/** 指定源是否播放中（按钮 UI 状态依据） */
function isPlaying(key: PreviewKey): boolean {
  return playing.value && currentKey.value === key;
}

export function useAudioPreview() {
  return { playing, play, stop, toggle, isPlaying };
}
