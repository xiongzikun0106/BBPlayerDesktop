import type { AlertModalProps } from '@/components/modals/AlertModal'
import type { GarbSkinSearchResult } from '@bbplayer/core'
import type { MatchResult } from '@/lib/services/externalPlaylistService'
import type { Playlist, Track } from '@bbplayer/core'
import type { GenericTrack } from '@bbplayer/core'
import type { LyricFileData } from '@bbplayer/core'
import type { CreateArtistPayload } from '@bbplayer/core'
import type { CreateTrackPayload } from '@bbplayer/core'

export interface ModalPropsMap {
	ManualMatchExternalSync: {
		track: GenericTrack
		initialQuery: string
		onMatch: (result: MatchResult) => void
	}
	AddVideoToBilibiliFavorite: { bvid: string }
	EditPlaylistMetadata: { playlist: Playlist }
	EditTrackMetadata: { track: Track }
	CookieLogin: undefined
	CreatePlaylist: { redirectToNewPlaylist?: boolean }
	UpdateApp: { version: string; notes: string; url: string; forced?: boolean }
	UpdateTrackLocalPlaylists: { track: Track }
	BatchAddTracksToLocalPlaylist: {
		payloads: { track: CreateTrackPayload; artist: CreateArtistPayload }[]
	}
	DuplicateLocalPlaylist: { sourcePlaylistId: number; rawName: string }
	ManualSearchLyrics: { uniqueKey: string; initialQuery: string }
	InputExternalPlaylistInfo: undefined
	Alert: AlertModalProps
	EditLyrics: { uniqueKey: string; lyrics: LyricFileData }
	SleepTimer: undefined
	SaveQueueToPlaylist: { trackIds: string[] }
	DonationQR: { type: 'wechat' | 'alipay' }
	PlaybackSpeed: undefined
	LyricsSelection: undefined
	SongShare: undefined
	SyncLocalToBilibili: { playlistId: number }
	SyncOptions: {
		favoriteId: number
		shouldRedirectToLocalPlaylist?: boolean
	}
	FavoriteSyncProgress: {
		favoriteId: number
		shouldRedirectToLocalPlaylist?: boolean
		expandMultiPage?: boolean
	}
	CoverDownloadProgress: undefined
	SkinDownloadProgress: { item: GarbSkinSearchResult }
	EnableSharing: {
		playlistId: number
		shareId?: string | null
		shareRole?: 'owner' | 'editor' | 'subscriber' | null
	}
	SubscribeToSharedPlaylist: undefined
	MergePlaylists: undefined
}

export type ModalKey = keyof ModalPropsMap
export interface ModalInstance<K extends ModalKey = ModalKey> {
	key: K
	props: ModalPropsMap[K]
	options?: { dismissible?: boolean } // default: true
}
