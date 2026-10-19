import { useState } from "react";
import { AlertTriangle, Edit3, Loader } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BaseModal } from "./base-modal";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { formatCaptureMoment } from "@/lib/fits";
import { fromDateTimeInput, timeZoneLabel, toDateTimeInput } from "@/lib/datetime";
import type { AstroImage } from "@shared/schema";

interface ImageDetailsEditorModalProps {
  image: AstroImage;
  onClose: () => void;
}

const toDateTimeLocalValue = toDateTimeInput;

export function ImageDetailsEditorModal({ image, onClose }: ImageDetailsEditorModalProps) {
  const [title, setTitle] = useState(image.title || "");
  const [captureDateLocal, setCaptureDateLocal] = useState(() => toDateTimeLocalValue(image.captureDate));
  const [isSaving, setIsSaving] = useState(false);
  const queryClient = useQueryClient();

  const originalCaptureDateLocal = toDateTimeLocalValue(image.captureDate);
  const captureDateChanged = captureDateLocal !== originalCaptureDateLocal;
  const moment = formatCaptureMoment(image.captureDate, image.originalPath, image.captureDateSource);

  const handleSave = async () => {
    if (!title.trim()) return;

    setIsSaving(true);
    try {
      const updates: Record<string, unknown> = { title: title.trim() };
      if (captureDateChanged) {
        updates.captureDate = fromDateTimeInput(captureDateLocal)?.toISOString() ?? null;
      }
      await apiRequest("PATCH", `/api/images/${image.id}`, updates);

      await queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/images", image.id] });
      onClose();
    } catch (error) {
      console.error("Failed to update image details:", error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <BaseModal onClose={onClose} title="Edit Image Details" icon={<Edit3 className="h-5 w-5 text-blue-400" />}>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title" className="text-sm font-medium text-gray-300">Display Name</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter image title..."
            className="bg-gray-800 border-gray-700 text-white focus:ring-blue-500 focus:border-blue-500"
            autoFocus
          />
          <p className="text-xs text-gray-500">
            This is a visual rename. The original filename <code className="bg-gray-800 px-1 rounded">{image.filename}</code> remains unchanged for system linking.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="captureDate" className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
            Captured on <span className="font-mono text-xs text-gray-500">({timeZoneLabel()})</span>
            {!captureDateChanged && moment.status === 'unverified' && (
              <span title="The time may not be exact — it comes from file metadata, not a verified exposure timestamp."><AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Time not verified" /></span>
            )}
            {!captureDateChanged && moment.status === 'edited' && <span className="text-xs italic text-gray-500">(edited)</span>}
          </Label>
          <Input
            id="captureDate"
            type="datetime-local"
            value={captureDateLocal}
            onChange={(e) => setCaptureDateLocal(e.target.value)}
            className="bg-gray-800 border-gray-700 text-white focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="text-xs text-gray-500">
            {image.captureDateSource === 'file' || image.captureDateSource === null
              ? "This time came from file metadata, not a verified exposure timestamp — correct it here if you know the real capture time."
              : "Correct this if the detected capture time is wrong."}
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-6 border-t border-gray-800 mt-6">
          <Button variant="outline" onClick={onClose} className="border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || !title.trim() || (title === image.title && !captureDateChanged)}
            className="bg-blue-600 hover:bg-blue-700 text-white min-w-[100px]"
          >
            {isSaving ? (
              <>
                <Loader className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : "Save"}
          </Button>
        </div>
      </div>
    </BaseModal>
  );
}
