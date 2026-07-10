; CassiopeiaPapyrusExtender - native event callback signatures
; Source: CassiopeiaPapyrusEvents.txt (Cassiopeia Papyrus Extender 9.4) by LarannKiar
; Global callback functions scripts must define to receive native events.
; Register with: RegisterForNativeEvent("ScriptName", "EventName")
;
; Declared `global native` so the signatures resolve without a body. In your own
; script you implement them as ordinary `global` functions.

Scriptname CassiopeiaPapyrusEvents native hidden


; ##### Events with callback parameters #####

; when this actor equips / unequips something
; akFilter support: can be filtered by akSource
Function TESEquipEvent(Actor akSource, Int akItemBaseID, bool abEquipped) global native

; sent when this cell gets fully loaded
; has akFilter support
Function TESCellFullyLoadedEvent(Cell akCell) global native

; sent when a reference Activates another
; has akFilter support ( code checks for both the activated and the action references, disjunctive )
Function TESActivateEvent(ObjectReference akActivatedRef, ObjectReference akActionRef) global native

; workshop events
; have akFilter support ( code checks for both itemRef and workshopRef, disjunctive )
Function Workshop_ItemGrabbedEvent(ObjectReference itemRef, ObjectReference workshopRef) global native

Function Workshop_ItemMovedEvent(ObjectReference itemRef, ObjectReference workshopRef) global native

Function Workshop_ItemPlacedEvent(ObjectReference itemRef, ObjectReference workshopRef) global native

; input event
; ( aiKeyCode is Virtual-Key Code, see https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes )
Function BSInputEvent(Int aiKeyCode, String asControlName, String asFriendlyName, bool bPressed, Float afHeldTime) global native

; sent when the player clicks OK to close the TextInputMenu
Function TextInputMenu_EndEditText(String sInputText) global native

; when this form is deleted
; note that scripts must be previously filtered for the deleted form to receive this event
Function TESFormDeleteEvent(Int aiDeletedFormID) global native

; when this reference is loaded / unloaded
; has akFilter support
Function TESObjectLoadedEvent(ObjectReference akReference, bool abLoaded) global native

; sent when this actor changes their ParentCell
; has akFilter support ( code can check for the actor and the cells, disjunctive )
Function ActorCellChangeEvent(Actor akActor, Cell akPreviousCell, Cell akCurrentCell) global native

; when this reference's 3D is attached
; has akFilter support ( code can check its GetBaseObject() too, disjunctive )
Function ReferenceSet3d(ObjectReference akReference) global native

; when this location is loaded
Function BGSLocationLoadedEvent(Location akLocation) global native

; when this actor enters/exits a furniture
; has akFilter support ( code can check both akActor and akFurniture, disjunctive )
Function TESFurnitureEvent(Actor akActor, ObjectReference akFurniture, Bool abExiting) global native

; when an actor Harvests a Flora reference
; has akFilter support ( code can check akActor, akHarvestedReference and akProduceForm as well, disjunctive )
Function TESHarvestEvent(Actor akActor, ObjectReference akHarvestedReference, Form akProduceForm) global native

; when this Outpost is removed
; has akFilter support ( code can check akOutpostCell, akOutpostLocation and akOutpostWorldSpace as well, disjunctive )
Function RemoveOutpostEvent(Cell akOutpostCell, Location akOutpostLocation, WorldSpace akOutpostWorldSpace) global native


; ##### Events with no callback parameters #####

Function TESLoadGameEvent() global native
Function FirstThirdPersonSwitch() global native
Function Workshop_CargoLinkAddedEvent() global native
Function Workshop_CargoLinkTargetChangedEvent() global native
Function Workshop_EnterOutpostBeaconModeEvent() global native
Function Workshop_ItemProducedEvent() global native
Function Workshop_ItemRemovedEvent() global native
Function Workshop_ItemRepairedEvent() global native
Function Workshop_ItemScrappedEvent() global native
Function Workshop_OutpostNameChangedEvent() global native
Function Workshop_OutpostPlacedEvent() global native
Function Workshop_PlacementStatusEvent() global native
Function Workshop_PowerOffEvent() global native
Function Workshop_PowerOnEvent() global native
Function Workshop_SnapBehaviorCycledEvent() global native
Function Workshop_WorkshopFlyCameraEvent() global native
Function Workshop_WorkshopItemPlacedEvent() global native
Function Workshop_WorkshopModeEvent() global native
Function Workshop_WorkshopOutputLinkEvent() global native
Function Workshop_WorkshopStatsChangedEvent() global native
Function Workshop_WorkshopUpdateStatsEvent() global native
Function CraftingMenu_CraftItem() global native
Function CraftingMenu_InstallMod() global native
Function CraftingMenu_RenameItem() global native
Function StarMapMenu_ExecuteRoute() global native
Function StarMapMenu_Galaxy_FocusSystem() global native
Function StarMapMenu_LandingInputInProgress() global native
Function StarMapMenu_MarkerGroupContainerVisibilityChanged() global native
Function StarMapMenu_MarkerGroupEntryClicked() global native
Function StarMapMenu_MarkerGroupEntryHoverChanged() global native
Function StarMapMenu_OnCancel() global native
Function StarMapMenu_OnClearRoute() global native
Function StarMapMenu_OnExitStarMap() global native
Function StarMapMenu_OnGalaxyViewInitialized() global native
Function StarMapMenu_OnHintButtonClicked() global native
Function StarMapMenu_OnOutpostEntrySelected() global native
Function StarMapMenu_QuickSelectChange() global native
Function StarMapMenu_ReadyToClose() global native
Function StarMapMenu_ScanPlanet() global native
Function StarMapMenu_SelectedLandingSite() global native
Function StarMapMenu_ShowRealCursor() global native
Function SurfaceMapMenu_MarkerClicked() global native
Function SurfaceMapMenu_TryPlaceCustomMarker() global native
Function PhotoMode_TakeSnapshot() global native
