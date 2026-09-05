// Single source of truth for every icon the app uses — pages import from
// here, never from 'lucide-react' directly, so the same action can never
// silently end up with a different icon on a different page (the
// enforcement is social/review-time, not technical, but centralizing the
// map is what makes that reviewable at all). Previously the app used raw
// emoji characters throughout; this is a straight semantic replacement,
// not a redesign — no icon here changes what its page communicates.
import {
  LayoutDashboard,
  Camera,
  CheckCheck,
  MoreHorizontal,
  Receipt,
  Landmark,
  CreditCard,
  FileText,
  Paperclip,
  X,
  ArrowLeft,
  Download,
  RotateCw,
  CircleCheck,
  CircleAlert,
  TriangleAlert,
} from 'lucide-react'

export const NavOverviewIcon = LayoutDashboard
export const NavCaptureIcon = Camera
export const NavReconcileIcon = CheckCheck
export const NavMoreIcon = MoreHorizontal

export const ReceiptIcon = Receipt
export const BankStatementIcon = Landmark
export const CreditCardIcon = CreditCard
export const DocumentIcon = FileText
export const AttachIcon = Paperclip
export const CloseIcon = X
export const BackIcon = ArrowLeft
export const DownloadIcon = Download
export const RescanIcon = RotateCw

export const MatchedIcon = CircleCheck
export const NeedsReviewIcon = CircleAlert
export const WarningIcon = TriangleAlert

// Default stroke width used everywhere an icon renders, per the "same
// weight at the same level" rule — pass explicit size via the `size` prop
// as needed, but leave strokeWidth alone.
export const ICON_STROKE_WIDTH = 1.8
