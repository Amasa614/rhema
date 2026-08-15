import { useBroadcastStore } from "@/stores/broadcast-store"
import { pickThemeLogoImage } from "@/lib/theme-designer-files"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { BroadcastTheme } from "@/types/broadcast"

type ThemeLogo = NonNullable<BroadcastTheme["logo"]>
type LogoPosition = ThemeLogo["position"]

const DEFAULT_LOGO: ThemeLogo = {
  enabled: true,
  url: "",
  position: "top-right",
  sizePercent: 14,
  opacity: 1,
  margin: 48,
}

const POSITIONS: { value: LogoPosition; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-center", label: "Top center" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-right", label: "Bottom right" },
]

export function LogoProperties() {
  const draftTheme = useBroadcastStore((s) => s.draftTheme)
  const update = useBroadcastStore((s) => s.updateDraftNested)

  if (!draftTheme) return null

  const logo = draftTheme.logo
  const hasImage = Boolean(logo?.url)

  const setLogo = (next: ThemeLogo | undefined) => {
    update("logo", next)
  }

  const patchLogo = (patch: Partial<ThemeLogo>) => {
    setLogo({
      ...(logo ?? DEFAULT_LOGO),
      ...patch,
    })
  }

  const pickLogo = () => {
    void (async () => {
      const dataUrl = await pickThemeLogoImage()
      if (!dataUrl) return
      patchLogo({ url: dataUrl, enabled: true })
    })()
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Optional church or ministry mark. Use a PNG with a transparent background.
      </p>

      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="theme-logo-enabled">
          Show logo
        </label>
        <Switch
          id="theme-logo-enabled"
          checked={Boolean(logo?.enabled && hasImage)}
          disabled={!hasImage}
          onCheckedChange={(checked) => {
            if (!logo) return
            patchLogo({ enabled: checked })
          }}
        />
      </div>

      {hasImage ? (
        <div className="overflow-hidden rounded-md border border-border bg-muted/30 p-2">
          <img
            src={logo!.url}
            alt="Theme logo preview"
            className="mx-auto max-h-20 object-contain"
          />
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No logo yet
        </div>
      )}

      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" className="flex-1" onClick={pickLogo}>
          {hasImage ? "Change image" : "Choose PNG"}
        </Button>
        {hasImage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLogo(undefined)}
          >
            Remove
          </Button>
        ) : null}
      </div>

      {hasImage ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Position</label>
            <Select
              value={logo?.position ?? "top-right"}
              onValueChange={(value) => patchLogo({ position: value as LogoPosition })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POSITIONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Width</label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {logo?.sizePercent ?? DEFAULT_LOGO.sizePercent}%
              </span>
            </div>
            <Slider
              min={4}
              max={40}
              step={1}
              value={[logo?.sizePercent ?? DEFAULT_LOGO.sizePercent]}
              onValueChange={([value]) => patchLogo({ sizePercent: value })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Opacity</label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {Math.round((logo?.opacity ?? 1) * 100)}%
              </span>
            </div>
            <Slider
              min={10}
              max={100}
              step={1}
              value={[Math.round((logo?.opacity ?? 1) * 100)]}
              onValueChange={([value]) => patchLogo({ opacity: value / 100 })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Margin</label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {logo?.margin ?? DEFAULT_LOGO.margin}px
              </span>
            </div>
            <Slider
              min={0}
              max={160}
              step={2}
              value={[logo?.margin ?? DEFAULT_LOGO.margin]}
              onValueChange={([value]) => patchLogo({ margin: value })}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}
