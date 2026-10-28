import type { KeenonSceneInfo } from '../../../src/vendors/keenon/shared'

/** A `keenon_robot_scenes` row. */
export interface SceneRow {
  robot_id: string
  detected_scene_code: string | null
  detected_scene_name: string | null
  manual_scene_code: string | null
  manual_scene_name: string | null
  discovered_at: string | null
  discovery_error: string | null
}

/** The scene a robot works in: the one an admin picked, else the one it reports. */
export function currentScene(scene: SceneRow | undefined): KeenonSceneInfo {
  if (scene?.manual_scene_code) return { code: scene.manual_scene_code, name: scene.manual_scene_name, source: 'manual' }
  if (scene?.detected_scene_code) {
    return { code: scene.detected_scene_code, name: scene.detected_scene_name, source: 'detected' }
  }
  return { code: null, name: null, source: null }
}
