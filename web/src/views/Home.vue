<template>
  <div class="home">
    <!-- Bot Instance Selector -->
    <div class="bot-selector" v-if="store.bots.length > 1">
      <button
        v-for="bot in store.bots"
        :key="bot.id"
        class="bot-tab"
        :class="{ active: bot.id === store.activeBotId }"
        @click="store.setActiveBotId(bot.id)"
      >
        {{ bot.name }}
      </button>
    </div>

    <!-- Search Bar -->
    <div class="search-bar" @click="$router.push('/search')">
      <Icon icon="mdi:magnify" class="search-icon" />
      <span class="search-placeholder">搜索歌曲、歌单、专辑...</span>
    </div>

    <!-- Now Playing -->
    <section v-if="store.currentSong" class="section">
      <h2 class="section-title">正在播放</h2>
      <div class="now-playing">
        <CoverArt :url="store.currentSong.coverUrl" :size="80" :radius="10" :show-shadow="true" />
        <div class="now-playing-info">
          <div class="now-playing-name">{{ store.currentSong.name }}</div>
          <div class="now-playing-artist">{{ store.currentSong.artist }} · {{ store.currentSong.album }}</div>
        </div>
      </div>
    </section>

    <!-- Recommended Playlists -->
    <section class="section">
      <h2 class="section-title">推荐歌单</h2>
      <div class="playlist-grid">
        <div
          v-for="playlist in playlists"
          :key="playlist.id"
          class="playlist-card hover-scale"
          @click="$router.push(`/playlist/${playlist.id}?platform=${playlist.platform}`)"
        >
          <CoverArt :url="playlist.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ playlist.name }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import CoverArt from '../components/CoverArt.vue';

const store = usePlayerStore();

interface Playlist {
  id: string;
  name: string;
  coverUrl: string;
  platform: string;
}

const playlists = ref<Playlist[]>([]);

onMounted(async () => {
  try {
    const res = await axios.get('/api/music/recommend/playlists');
    playlists.value = res.data.playlists;
  } catch {
    // Ignore if API not ready
  }
});
</script>

<style lang="scss" scoped>
.bot-selector {
  display: flex;
  gap: 12px;
  margin-bottom: 28px;
}

.bot-tab {
  padding: 8px 20px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  background: var(--hover-bg);
  opacity: 0.6;
  transition: all var(--transition-fast);

  &.active {
    background: var(--color-primary);
    color: white;
    opacity: 1;
  }
}

.search-bar {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 32px;
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover { background: var(--hover-bg); }
}

.search-icon {
  font-size: 20px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-placeholder {
  opacity: 0.3;
  font-size: 14px;
}

.section {
  margin-bottom: 36px;
}

.section-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 16px;
}

.now-playing {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.now-playing-name {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 4px;
}

.now-playing-artist {
  font-size: 13px;
  color: var(--text-secondary);
}

.playlist-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 24px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
}

.playlist-card {
  cursor: pointer;
}

.playlist-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
