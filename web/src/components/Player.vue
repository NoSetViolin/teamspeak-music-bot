<template>
  <div class="player-bar frosted-glass" v-if="currentSong">
    <div class="player-left">
      <CoverArt :url="currentSong.coverUrl" :size="40" />
      <div class="song-info">
        <div class="song-name">{{ currentSong.name }}</div>
        <div class="song-artist">{{ currentSong.artist }}</div>
      </div>
    </div>

    <div class="player-center">
      <button class="control-btn" @click="store.prev()">
        <Icon icon="mdi:skip-previous" />
      </button>
      <button class="play-btn" @click="togglePlay">
        <Icon :icon="store.isPlaying ? 'mdi:pause' : 'mdi:play'" />
      </button>
      <button class="control-btn" @click="store.next()">
        <Icon icon="mdi:skip-next" />
      </button>
    </div>

    <div class="player-right">
      <Icon icon="mdi:volume-high" class="volume-icon" />
      <input
        type="range"
        min="0"
        max="100"
        :value="activeBot?.volume ?? 75"
        @input="onVolumeChange"
        class="volume-slider"
      />
      <button class="control-btn" @click="showQueue = !showQueue">
        <Icon icon="mdi:playlist-music" />
      </button>
      <RouterLink to="/lyrics" class="control-btn lyrics-btn">
        <Icon icon="mdi:microphone" />
      </RouterLink>
    </div>
    <Queue :open="showQueue" @close="showQueue = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { usePlayerStore } from '../stores/player.js';
import CoverArt from './CoverArt.vue';
import Queue from './Queue.vue';

const showQueue = ref(false);

const store = usePlayerStore();
const activeBot = computed(() => store.activeBot);
const currentSong = computed(() => store.currentSong);

function togglePlay() {
  if (store.isPlaying) {
    store.pause();
  } else {
    store.resume();
  }
}

function onVolumeChange(e: Event) {
  const target = e.target as HTMLInputElement;
  store.setVolume(parseInt(target.value));
}
</script>

<style lang="scss" scoped>
.player-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: var(--player-height);
  display: flex;
  align-items: center;
  padding: 0 24px;
  z-index: 100;
  border-top: 1px solid var(--border-color);
}

.player-left {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 240px;
}

.song-info {
  min-width: 0;
}

.song-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-artist {
  font-size: 11px;
  color: var(--text-secondary);
}

.player-center {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 20px;
}

.control-btn {
  font-size: 20px;
  opacity: 0.7;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.play-btn {
  width: 32px;
  height: 32px;
  background: var(--color-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: white;
  transition: transform var(--transition-fast);
  &:hover { transform: scale(1.08); }
  &:active { transform: scale(0.95); }
}

.player-right {
  width: 240px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.volume-icon {
  font-size: 18px;
  opacity: 0.6;
}

.volume-slider {
  width: 80px;
  height: 3px;
  appearance: none;
  background: var(--border-color);
  border-radius: 2px;
  outline: none;

  &::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    background: var(--color-primary);
    border-radius: 50%;
    cursor: pointer;
  }
}

.lyrics-btn {
  margin-left: 8px;
}
</style>
