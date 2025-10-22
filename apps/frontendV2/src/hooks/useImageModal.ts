import { useCallback, useState } from "react";

export function useImageModal() {
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [selectedImageSrc, setSelectedImageSrc] = useState<string>("");
  const [selectedImageAlt, setSelectedImageAlt] = useState<string>("");

  const openImageModal = useCallback((src: string, alt: string) => {
    setSelectedImageSrc(src);
    setSelectedImageAlt(alt);
    setImageModalOpen(true);
  }, []);

  const closeImageModal = useCallback(() => {
    setImageModalOpen(false);
    setSelectedImageSrc("");
    setSelectedImageAlt("");
  }, []);

  return {
    imageModalOpen,
    selectedImageSrc,
    selectedImageAlt,
    openImageModal,
    closeImageModal,
    setImageModalOpen,
  };
}
